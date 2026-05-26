import { NextRequest } from "next/server";

import {
  logCronFailure,
  logCronStart,
  logCronSuccess,
  logWorkerEvent,
} from "@/lib/cron-logging";
import { sql } from "@/lib/db";
import {
  fetchPaperFullTextWithStatus,
  type PaperFullText,
} from "@/lib/fetchers/paper-full-text";
import { rebuildPaperEvidenceLayerForFeedItem } from "@/lib/paper-evidence-layer";
import {
  claimNextDeterministicPaper,
  computePaperProcessingSourceHash,
  markDeterministicProcessingFailed,
  markDeterministicProcessingSucceeded,
  type ClaimedDeterministicPaper,
  type PaperEvidenceQuality,
  type PaperFullTextProcessingStatus,
  type PaperProcessingStateFeedItem,
} from "@/lib/paper-processing-state";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const DEFAULT_INTERNAL_DEADLINE_MS = 240_000;
const MIN_TIME_TO_CLAIM_MS = 5_000;
const MAX_WORKER_PAPER_LIMIT = 100;

export interface HydratePapersResult {
  paperLimit: number | null;
  limitReached: boolean;
  claimed: number;
  succeeded: number;
  failed: number;
  dead: number;
  fullTextSucceeded: number;
  fullTextUnavailable: number;
  fullTextFailed: number;
  deadlineReached: boolean;
  noWork: boolean;
  durationMs: number;
  errors: Array<{ feedItemId: number; error: string }>;
}

export interface HydratedPaperResult {
  fullTextStatus: PaperFullTextProcessingStatus;
  evidenceQuality: PaperEvidenceQuality;
  sections: number;
  spans: number;
  cards: number;
  profiles: number;
}

interface HydratePapersWorkerOptions {
  paperLimit?: number | null;
}

export class PaperHydrationError extends Error {
  fullTextStatus: PaperFullTextProcessingStatus | null;

  constructor(
    message: string,
    fullTextStatus: PaperFullTextProcessingStatus | null,
  ) {
    super(message);
    this.name = "PaperHydrationError";
    this.fullTextStatus = fullTextStatus;
  }
}

function getInternalDeadlineMs() {
  const configured = Number.parseInt(
    process.env.PAPER_HYDRATE_INTERNAL_DEADLINE_MS ?? "",
    10,
  );
  if (!Number.isFinite(configured) || configured < 0) {
    return DEFAULT_INTERNAL_DEADLINE_MS;
  }
  return Math.min(configured, DEFAULT_INTERNAL_DEADLINE_MS);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function evidenceQualityForPaper(
  paper: Pick<PaperProcessingStateFeedItem, "content" | "full_text">,
): PaperEvidenceQuality {
  if (paper.full_text?.trim()) {
    return "full_text";
  }
  if (paper.content?.trim()) {
    return "abstract_only";
  }
  return "metadata_only";
}

async function persistHydratedFeedItem(
  paper: PaperProcessingStateFeedItem,
  now: Date,
) {
  await sql`
    UPDATE feed_items
    SET full_text = ${paper.full_text ?? null},
        full_text_source = ${paper.full_text_source ?? null},
        last_hydrated_at = ${now.toISOString()}::timestamptz
    WHERE id = ${paper.id}
      AND source_type = 'paper'
  `;
}

async function resolveFullText(
  paper: ClaimedDeterministicPaper["paper"],
): Promise<{
  paper: ClaimedDeterministicPaper["paper"];
  fullTextStatus: PaperFullTextProcessingStatus;
}> {
  if (paper.full_text?.trim()) {
    return { paper, fullTextStatus: "succeeded" };
  }

  const fetched = await fetchPaperFullTextWithStatus(paper.external_id);
  if (fetched.status === "succeeded") {
    const fullText: PaperFullText = fetched.fullText;
    return {
      paper: {
        ...paper,
        full_text: fullText.text,
        full_text_source: fullText.source,
      },
      fullTextStatus: "succeeded",
    };
  }

  if (fetched.status === "unavailable") {
    return { paper, fullTextStatus: "unavailable" };
  }

  throw new PaperHydrationError(
    `full text fetch failed: ${fetched.error}`,
    "failed",
  );
}

function assertValidDeterministicEvidence(result: {
  skipped: boolean;
  sections: number;
  spans: number;
  cards: number;
  profiles?: number;
}) {
  if (result.skipped) {
    throw new Error("deterministic evidence build skipped: no source text");
  }
  if (
    result.sections <= 0 ||
    result.spans <= 0 ||
    result.cards <= 0 ||
    (result.profiles ?? 0) <= 0
  ) {
    throw new Error(
      `deterministic evidence build produced insufficient rows: sections=${result.sections} spans=${result.spans} cards=${result.cards} profiles=${result.profiles ?? 0}`,
    );
  }
}

function assertValidEvidenceQuality(
  evidenceQuality: PaperEvidenceQuality,
  paper: Pick<PaperProcessingStateFeedItem, "content" | "full_text">,
) {
  if (evidenceQuality === "unknown") {
    throw new Error("deterministic evidence quality is unknown");
  }
  if (
    evidenceQuality === "metadata_only" &&
    (paper.full_text?.trim() || paper.content?.trim())
  ) {
    throw new Error("deterministic evidence quality cannot be metadata_only with source text");
  }
}

export async function hydrateClaimedPaperDeterministically(
  claim: ClaimedDeterministicPaper,
  now: Date,
): Promise<HydratedPaperResult> {
  let fullTextStatus: PaperFullTextProcessingStatus | null = null;

  try {
    const resolved = await resolveFullText(claim.paper);
    const paper = resolved.paper;
    fullTextStatus = resolved.fullTextStatus;

    const rebuild = await rebuildPaperEvidenceLayerForFeedItem(sql, paper, {
      refreshChunks: true,
      extractorMode: "deterministic",
    });
    assertValidDeterministicEvidence(rebuild);
    const evidenceQuality = evidenceQualityForPaper(paper);
    assertValidEvidenceQuality(evidenceQuality, paper);

    await persistHydratedFeedItem(paper, now);
    await markDeterministicProcessingSucceeded(sql, {
      feedItemId: paper.id,
      leaseToken: claim.leaseToken,
      sourceHash: computePaperProcessingSourceHash(paper),
      expectedSourceHash: claim.state.source_hash,
      evidenceQuality,
      fullTextStatus,
      now,
    });

    return {
      fullTextStatus,
      evidenceQuality,
      sections: rebuild.sections,
      spans: rebuild.spans,
      cards: rebuild.cards,
      profiles: rebuild.profiles,
    };
  } catch (error) {
    if (error instanceof PaperHydrationError) {
      throw error;
    }
    throw new PaperHydrationError(errorMessage(error), fullTextStatus);
  }
}

export async function runHydratePapersWorker(
  options: HydratePapersWorkerOptions = {},
): Promise<HydratePapersResult> {
  const startedAt = Date.now();
  const deadlineMs = getInternalDeadlineMs();
  const paperLimit = normalizeWorkerPaperLimit(options.paperLimit);
  const result: HydratePapersResult = {
    paperLimit,
    limitReached: false,
    claimed: 0,
    succeeded: 0,
    failed: 0,
    dead: 0,
    fullTextSucceeded: 0,
    fullTextUnavailable: 0,
    fullTextFailed: 0,
    deadlineReached: false,
    noWork: false,
    durationMs: 0,
    errors: [],
  };

  while (true) {
    if (paperLimit !== null && result.claimed >= paperLimit) {
      result.limitReached = true;
      break;
    }

    const elapsedMs = Date.now() - startedAt;
    const remainingMs = deadlineMs - elapsedMs;
    if (remainingMs <= MIN_TIME_TO_CLAIM_MS) {
      result.deadlineReached = true;
      break;
    }

    const claim = await claimNextDeterministicPaper(sql);
    if (!claim) {
      result.noWork = true;
      break;
    }
    result.claimed += 1;
    const paperStartedAt = Date.now();
    const attempt = claim.state.deterministic_attempt_count + 1;

    logWorkerEvent("hydrate-papers", {
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
      const hydrated = await hydrateClaimedPaperDeterministically(
        claim,
        new Date(),
      );
      result.succeeded += 1;
      if (hydrated.fullTextStatus === "succeeded") {
        result.fullTextSucceeded += 1;
      } else if (hydrated.fullTextStatus === "unavailable") {
        result.fullTextUnavailable += 1;
      }

      logWorkerEvent("hydrate-papers", {
        event: "paper_success",
        feedItemId: claim.paper.id,
        externalId: claim.paper.external_id,
        phase: "deterministic",
        attempt,
        durationMs: Date.now() - paperStartedAt,
        timeRemainingMs: Math.max(0, deadlineMs - (Date.now() - startedAt)),
        status: "succeeded",
        fullTextStatus: hydrated.fullTextStatus,
        evidenceQuality: hydrated.evidenceQuality,
        sections: hydrated.sections,
        spans: hydrated.spans,
        cards: hydrated.cards,
        profiles: hydrated.profiles,
      });
    } catch (error) {
      const hydrationError =
        error instanceof PaperHydrationError
          ? error
          : new PaperHydrationError(errorMessage(error), null);
      if (hydrationError.fullTextStatus === "failed") {
        result.fullTextFailed += 1;
      }

      const failure = await markDeterministicProcessingFailed(sql, {
        feedItemId: claim.paper.id,
        leaseToken: claim.leaseToken,
        error: hydrationError,
        fullTextStatus: hydrationError.fullTextStatus,
      });
      if (failure.dead) {
        result.dead += 1;
      } else {
        result.failed += 1;
      }
      result.errors.push({
        feedItemId: claim.paper.id,
        error: hydrationError.message,
      });

      logWorkerEvent(
        "hydrate-papers",
        {
          event: failure.dead ? "paper_dead" : "paper_failure",
          feedItemId: claim.paper.id,
          externalId: claim.paper.external_id,
          phase: "deterministic",
          attempt: failure.attemptCount,
          durationMs: Date.now() - paperStartedAt,
          timeRemainingMs: Math.max(0, deadlineMs - (Date.now() - startedAt)),
          status: failure.status,
          nextRunAt: failure.nextRunAt?.toISOString() ?? null,
          error: hydrationError,
        },
        "error",
      );
    }
  }

  result.durationMs = Date.now() - startedAt;
  if (result.deadlineReached) {
    logWorkerEvent("hydrate-papers", {
      event: "deadline_exit",
      phase: "deadline",
      durationMs: result.durationMs,
      timeRemainingMs: Math.max(0, deadlineMs - result.durationMs),
      status: "deadline_reached",
      claimed: result.claimed,
    });
  }
  if (result.limitReached) {
    logWorkerEvent("hydrate-papers", {
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
  logCronStart("hydrate-papers", request);

  try {
    const result = await runHydratePapersWorker({
      paperLimit: limitParam.paperLimit,
    });
    logCronSuccess("hydrate-papers", request, startedAt, {
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
    logCronFailure("hydrate-papers", request, startedAt, err);
    return Response.json(
      { error: `Failed to hydrate papers: ${errorMessage(err)}` },
      { status: 500 },
    );
  }
}
