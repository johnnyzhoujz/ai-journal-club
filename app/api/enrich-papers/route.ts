import { NextRequest } from "next/server";

import {
  logCronFailure,
  logCronStart,
  logCronSuccess,
  logWorkerEvent,
} from "@/lib/cron-logging";
import { sql } from "@/lib/db";
import {
  preparePaperEvidenceLayerForFeedItem,
  publishPreparedPaperEvidenceLayer,
} from "@/lib/paper-evidence-layer";
import {
  claimNextSemanticPaper,
  markSemanticProcessingFailed,
  markSemanticProcessingSucceeded,
  type ClaimedSemanticPaper,
  type PaperProcessingState,
} from "@/lib/paper-processing-state";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const DEFAULT_INTERNAL_DEADLINE_MS = 280_000;
const DEFAULT_LLM_TIMEOUT_MS = 280_000;
const MIN_TIME_TO_EXIT_MS = 30_000;
const DEFAULT_MIN_SEMANTIC_ATTEMPT_MS = 120_000;
const MAX_WORKER_PAPER_LIMIT = 100;

export interface EnrichPapersResult {
  enabled: boolean;
  skipped: boolean;
  skipReason: "disabled" | null;
  paperLimit: number | null;
  limitReached: boolean;
  claimed: number;
  succeeded: number;
  failed: number;
  dead: number;
  deadlineReached: boolean;
  noWork: boolean;
  durationMs: number;
  droppedSpans: number;
  droppedClaims: number;
  droppedAnchors: number;
  embeddingInputCount: number;
  embeddingFailedCount: number;
  llmInputTokens: number;
  llmOutputTokens: number;
  errors: Array<{ feedItemId: number; error: string }>;
}

interface EnrichPapersWorkerOptions {
  paperLimit?: number | null;
}

class PaperSemanticTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`semantic LLM extraction timed out after ${timeoutMs}ms`);
    this.name = "PaperSemanticTimeoutError";
  }
}

function isSemanticEnrichmentEnabled() {
  return process.env.PAPER_SEMANTIC_ENRICHMENT_ENABLED === "true";
}

function getInternalDeadlineMs() {
  const configured = Number.parseInt(
    process.env.PAPER_ENRICH_INTERNAL_DEADLINE_MS ?? "",
    10,
  );
  if (!Number.isFinite(configured) || configured < 0) {
    return DEFAULT_INTERNAL_DEADLINE_MS;
  }
  return Math.min(configured, DEFAULT_INTERNAL_DEADLINE_MS);
}

function getLlmTimeoutMs() {
  const configured = Number.parseInt(
    process.env.PAPER_SEMANTIC_LLM_TIMEOUT_MS ?? "",
    10,
  );
  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_LLM_TIMEOUT_MS;
  }
  return Math.min(configured, DEFAULT_LLM_TIMEOUT_MS);
}

function getMinSemanticAttemptMs() {
  const configured = Number.parseInt(
    process.env.PAPER_SEMANTIC_MIN_ATTEMPT_MS ?? "",
    10,
  );
  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_MIN_SEMANTIC_ATTEMPT_MS;
  }
  return Math.min(configured, DEFAULT_LLM_TIMEOUT_MS);
}

export function minimumSemanticClaimTimeRemainingMs({
  llmTimeoutMs,
  minSemanticAttemptMs,
}: {
  llmTimeoutMs: number;
  minSemanticAttemptMs: number;
}) {
  return Math.min(llmTimeoutMs, minSemanticAttemptMs) + MIN_TIME_TO_EXIT_MS;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function semanticFinalizationRetryMessage(state: PaperProcessingState): string {
  return state.semantic_last_error ??
    `semantic processing did not finalize; status=${state.semantic_status} digest_ready=${state.digest_ready}`;
}

function normalizeWorkerPaperLimit(limit: number | null | undefined) {
  if (!Number.isInteger(limit) || (limit ?? 0) < 1) {
    return null;
  }
  return Math.min(limit as number, MAX_WORKER_PAPER_LIMIT);
}

function parsePaperLimitParam(request: NextRequest):
  | { paperLimit: number | null }
  | { error: string } {
  const raw = request.nextUrl.searchParams.get("limit");
  if (raw === null) {
    return { paperLimit: null };
  }

  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return {
      error: `limit must be an integer between 1 and ${MAX_WORKER_PAPER_LIMIT}`,
    };
  }

  const paperLimit = Number.parseInt(trimmed, 10);
  if (paperLimit < 1 || paperLimit > MAX_WORKER_PAPER_LIMIT) {
    return {
      error: `limit must be an integer between 1 and ${MAX_WORKER_PAPER_LIMIT}`,
    };
  }

  return { paperLimit };
}

async function withTimeout<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new PaperSemanticTimeoutError(timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function assertValidSemanticEvidence(result: {
  skipped: boolean;
  sections: number;
  spans: number;
  cards: number;
  profiles?: number;
}) {
  if (result.skipped) {
    throw new Error("semantic evidence build skipped: no source text");
  }
  if (
    result.sections <= 0 ||
    result.spans <= 0 ||
    result.cards <= 0 ||
    (result.profiles ?? 0) <= 0
  ) {
    throw new Error(
      `semantic evidence build produced insufficient rows: sections=${result.sections} spans=${result.spans} cards=${result.cards} profiles=${result.profiles ?? 0}`,
    );
  }
}

export async function enrichClaimedPaperSemantically(
  claim: ClaimedSemanticPaper,
  timeoutMs: number,
) {
  const prepared = await withTimeout(timeoutMs, (signal) =>
    preparePaperEvidenceLayerForFeedItem(sql, claim.paper, {
      refreshChunks: false,
      extractorMode: "llm",
      signal,
    }),
  );
  assertValidSemanticEvidence({
    skipped: prepared.skipped,
    sections: prepared.drafts?.sections.length ?? 0,
    spans: prepared.drafts?.spans.length ?? 0,
    cards: prepared.drafts?.cards.length ?? 0,
    profiles: prepared.drafts ? 1 : 0,
  });
  const rebuild = await publishPreparedPaperEvidenceLayer(sql, prepared);
  assertValidSemanticEvidence(rebuild);
  const processingState = await markSemanticProcessingSucceeded(sql, {
    feedItemId: claim.paper.id,
    leaseToken: claim.leaseToken,
    expectedSourceHash: claim.state.source_hash,
  });
  return { ...rebuild, processingState };
}

function disabledResult(
  startedAt: number,
  paperLimit: number | null,
): EnrichPapersResult {
  return {
    enabled: false,
    skipped: true,
    skipReason: "disabled",
    paperLimit,
    limitReached: false,
    claimed: 0,
    succeeded: 0,
    failed: 0,
    dead: 0,
    deadlineReached: false,
    noWork: false,
    durationMs: Date.now() - startedAt,
    droppedSpans: 0,
    droppedClaims: 0,
    droppedAnchors: 0,
    embeddingInputCount: 0,
    embeddingFailedCount: 0,
    llmInputTokens: 0,
    llmOutputTokens: 0,
    errors: [],
  };
}

export async function runEnrichPapersWorker(
  options: EnrichPapersWorkerOptions = {},
): Promise<EnrichPapersResult> {
  const startedAt = Date.now();
  const paperLimit = normalizeWorkerPaperLimit(options.paperLimit);
  if (!isSemanticEnrichmentEnabled()) {
    return disabledResult(startedAt, paperLimit);
  }

  const deadlineMs = getInternalDeadlineMs();
  const llmTimeoutMs = getLlmTimeoutMs();
  const minClaimTimeRemainingMs = minimumSemanticClaimTimeRemainingMs({
    llmTimeoutMs,
    minSemanticAttemptMs: getMinSemanticAttemptMs(),
  });
  const result: EnrichPapersResult = {
    enabled: true,
    skipped: false,
    skipReason: null,
    paperLimit,
    limitReached: false,
    claimed: 0,
    succeeded: 0,
    failed: 0,
    dead: 0,
    deadlineReached: false,
    noWork: false,
    durationMs: 0,
    droppedSpans: 0,
    droppedClaims: 0,
    droppedAnchors: 0,
    embeddingInputCount: 0,
    embeddingFailedCount: 0,
    llmInputTokens: 0,
    llmOutputTokens: 0,
    errors: [],
  };

  while (true) {
    if (paperLimit !== null && result.claimed >= paperLimit) {
      result.limitReached = true;
      break;
    }

    const elapsedMs = Date.now() - startedAt;
    const remainingMs = deadlineMs - elapsedMs;
    if (remainingMs <= minClaimTimeRemainingMs) {
      result.deadlineReached = true;
      break;
    }

    const claim = await claimNextSemanticPaper(sql);
    if (!claim) {
      result.noWork = true;
      break;
    }
    result.claimed += 1;
    const paperStartedAt = Date.now();
    const attempt = claim.state.semantic_attempt_count + 1;

    logWorkerEvent("enrich-papers", {
      event: "claimed",
      feedItemId: claim.paper.id,
      externalId: claim.paper.external_id,
      phase: "claim",
      attempt,
      durationMs: 0,
      timeRemainingMs: remainingMs,
      status: "running",
    });

    try {
      const timeoutMs = Math.max(
        1,
        Math.min(llmTimeoutMs, remainingMs - MIN_TIME_TO_EXIT_MS),
      );
      const enriched = await enrichClaimedPaperSemantically(claim, timeoutMs);
      if (
        enriched.processingState.semantic_status !== "succeeded" ||
        enriched.processingState.digest_ready !== true
      ) {
        const message = semanticFinalizationRetryMessage(enriched.processingState);
        const dead = enriched.processingState.semantic_status === "dead";
        if (dead) {
          result.dead += 1;
        } else {
          result.failed += 1;
        }
        result.errors.push({
          feedItemId: claim.paper.id,
          error: message,
        });

        logWorkerEvent(
          "enrich-papers",
          {
            event: dead ? "paper_dead" : "paper_failure",
            feedItemId: claim.paper.id,
            externalId: claim.paper.external_id,
            phase: "semantic",
            attempt: enriched.processingState.semantic_attempt_count ?? attempt,
            durationMs: Date.now() - paperStartedAt,
            timeRemainingMs: Math.max(0, deadlineMs - (Date.now() - startedAt)),
            status: enriched.processingState.semantic_status,
            nextRunAt:
              enriched.processingState.semantic_next_run_at instanceof Date
                ? enriched.processingState.semantic_next_run_at.toISOString()
                : String(enriched.processingState.semantic_next_run_at),
            error: message,
          },
          "error",
        );
        continue;
      }

      result.succeeded += 1;
      result.droppedSpans += enriched.droppedSpans ?? 0;
      result.droppedClaims += enriched.droppedClaims ?? 0;
      result.droppedAnchors += enriched.droppedAnchors ?? 0;
      result.embeddingInputCount += enriched.embeddingInputCount ?? 0;
      result.embeddingFailedCount += enriched.embeddingFailedCount ?? 0;
      result.llmInputTokens += enriched.llmInputTokens ?? 0;
      result.llmOutputTokens += enriched.llmOutputTokens ?? 0;

      logWorkerEvent("enrich-papers", {
        event: "paper_success",
        feedItemId: claim.paper.id,
        externalId: claim.paper.external_id,
        phase: "semantic",
        attempt,
        durationMs: Date.now() - paperStartedAt,
        timeRemainingMs: Math.max(0, deadlineMs - (Date.now() - startedAt)),
        status: "succeeded",
        sections: enriched.sections,
        spans: enriched.spans,
        cards: enriched.cards,
        profiles: enriched.profiles,
        droppedSpans: enriched.droppedSpans ?? 0,
        droppedClaims: enriched.droppedClaims ?? 0,
        droppedAnchors: enriched.droppedAnchors ?? 0,
        embeddingFailedCount: enriched.embeddingFailedCount ?? 0,
        llmInputTokens: enriched.llmInputTokens ?? null,
        llmOutputTokens: enriched.llmOutputTokens ?? null,
      });
    } catch (error) {
      const failure = await markSemanticProcessingFailed(sql, {
        feedItemId: claim.paper.id,
        leaseToken: claim.leaseToken,
        error,
      });
      if (failure.dead) {
        result.dead += 1;
      } else {
        result.failed += 1;
      }
      result.errors.push({
        feedItemId: claim.paper.id,
        error: errorMessage(error),
      });

      logWorkerEvent(
        "enrich-papers",
        {
          event: failure.dead ? "paper_dead" : "paper_failure",
          feedItemId: claim.paper.id,
          externalId: claim.paper.external_id,
          phase: "semantic",
          attempt: failure.attemptCount,
          durationMs: Date.now() - paperStartedAt,
          timeRemainingMs: Math.max(0, deadlineMs - (Date.now() - startedAt)),
          status: failure.status,
          nextRunAt: failure.nextRunAt?.toISOString() ?? null,
          error,
        },
        "error",
      );
    }
  }

  result.durationMs = Date.now() - startedAt;
  if (result.deadlineReached) {
    logWorkerEvent("enrich-papers", {
      event: "deadline_exit",
      phase: "deadline",
      durationMs: result.durationMs,
      timeRemainingMs: Math.max(0, deadlineMs - result.durationMs),
      status: "deadline_reached",
      claimed: result.claimed,
    });
  }
  if (result.limitReached) {
    logWorkerEvent("enrich-papers", {
      event: "limit_exit",
      phase: "limit",
      durationMs: result.durationMs,
      timeRemainingMs: Math.max(0, deadlineMs - result.durationMs),
      status: "limit_reached",
      claimed: result.claimed,
      paperLimit,
    });
  }
  return result;
}

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return Response.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${cronSecret}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const limitParam = parsePaperLimitParam(request);
  if ("error" in limitParam) {
    return Response.json({ error: limitParam.error }, { status: 400 });
  }

  const startedAt = Date.now();
  logCronStart("enrich-papers", request);

  try {
    const result = await runEnrichPapersWorker({
      paperLimit: limitParam.paperLimit,
    });
    logCronSuccess("enrich-papers", request, startedAt, {
      enabled: result.enabled,
      skipped: result.skipped,
      skipReason: result.skipReason,
      paperLimit: result.paperLimit,
      limitReached: result.limitReached,
      claimed: result.claimed,
      succeeded: result.succeeded,
      failed: result.failed,
      dead: result.dead,
      deadlineReached: result.deadlineReached,
      noWork: result.noWork,
    });
    return Response.json(result);
  } catch (err) {
    logCronFailure("enrich-papers", request, startedAt, err);
    return Response.json(
      { error: `Failed to enrich papers: ${errorMessage(err)}` },
      { status: 500 },
    );
  }
}
