import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  sql: vi.fn(),
}));

vi.mock("@/lib/paper-evidence-layer", () => ({
  PAPER_EVIDENCE_LAYER_PARSER_VERSION: "parser:test",
  PAPER_EVIDENCE_LAYER_EXTRACTOR_VERSION: "extractor:test",
  computePaperEvidenceLayerSourceHash: (item: {
    id: number;
    title: string | null;
    content: string;
    full_text?: string | null;
  }) => [
    "paper-evidence-layer:test",
    item.id,
    item.title ?? "",
    item.content,
    item.full_text ?? "",
  ].join("\n"),
}));

import {
  calculateRetryNextRunAt,
  claimDeterministicPaperByFeedItemId,
  claimNextDeterministicPaper,
  claimNextSemanticPaper,
  claimSemanticPaperByFeedItemId,
  computePaperProcessingSourceHash,
  enqueueHotSetProcessingForFeedItems,
  ensurePaperProcessingStateForFeedItem,
  isPaperRichProcessingEligible,
  isPendingHotSetFinalizationAllowed,
  markDeterministicProcessingFailed,
  markDeterministicProcessingSucceeded,
  markSemanticProcessingFailed,
  markSemanticProcessingSucceeded,
  PAPER_SEMANTIC_MAX_ATTEMPTS,
  reconcilePendingHotSetPromotions,
  type PaperProcessingState,
  type PaperProcessingStateFeedItem,
} from "../paper-processing-state";

const NOW = new Date("2026-05-22T12:00:00.000Z");

type HarnessFeedItem = PaperProcessingStateFeedItem & {
  hot_set_reason?: string | null;
  archive_reason?: string | null;
  last_scored_at?: string | Date | null;
};

function paper(
  overrides: Partial<HarnessFeedItem> = {},
): HarnessFeedItem {
  return {
    id: 101,
    source_type: "paper",
    external_id: "2605.12345",
    title: "Test Paper",
    content: "This abstract describes a benchmark with 500 tasks.",
    url: "https://arxiv.org/abs/2605.12345",
    author_name: "Researcher",
    author_handle: null,
    published_at: "2026-05-21T00:00:00.000Z",
    fetched_at: "2026-05-21T00:00:00.000Z",
    corpus_tier: "hot_set",
    paper_meta: null,
    tier_metadata_json: null,
    full_text: null,
    full_text_source: null,
    hot_set_reason: null,
    archive_reason: null,
    last_scored_at: null,
    ...overrides,
  };
}

function state(
  overrides: Partial<PaperProcessingState> = {},
): PaperProcessingState {
  return {
    feed_item_id: 101,
    source_hash: "old-hash",
    evidence_quality: "unknown",
    full_text_status: "pending",
    deterministic_status: "pending",
    semantic_status: "pending",
    digest_ready: false,
    deterministic_attempt_count: 0,
    semantic_attempt_count: 0,
    deterministic_next_run_at: "2026-05-22T00:00:00.000Z",
    semantic_next_run_at: "2026-05-22T00:00:00.000Z",
    lease_token: null,
    lease_expires_at: null,
    deterministic_last_error: null,
    semantic_last_error: null,
    last_started_at: null,
    last_success_at: null,
    last_failed_at: null,
    created_at: "2026-05-22T00:00:00.000Z",
    updated_at: "2026-05-22T00:00:00.000Z",
    ...overrides,
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function harnessEvidenceSourceHash(
  item: Pick<HarnessFeedItem, "id" | "title" | "content" | "full_text">,
): string {
  return [
    "paper-evidence-layer:test",
    item.id,
    item.title ?? "",
    item.content,
    item.full_text ?? "",
  ].join("\n");
}

const OPTIONAL_RICH_EVIDENCE_TABLES = [
  "paper_sections",
  "paper_evidence_spans",
  "paper_evidence_cards",
  "paper_reader_profiles",
] as const;

type HarnessRichEvidenceCounts = Partial<Record<
  number,
  Partial<{
    sourceHash: string;
    sectionCount: number;
    spanCount: number;
    cardCount: number;
    profileCount: number;
  }>
>>;
type HarnessRichEvidenceCountKey =
  | "sectionCount"
  | "spanCount"
  | "cardCount"
  | "profileCount";

function createSqlHarness({
  states = [],
  papers = [],
  latestDigestSourceItemIds = [],
  latestDigestGeneratedAt = "2026-05-22T00:00:00.000Z",
  availableEvidenceTables = [...OPTIONAL_RICH_EVIDENCE_TABLES],
  richEvidenceCounts = {},
  finalizeThrows = false,
}: {
  states?: PaperProcessingState[];
  papers?: PaperProcessingStateFeedItem[];
  latestDigestSourceItemIds?: number[];
  latestDigestGeneratedAt?: string;
  availableEvidenceTables?: string[];
  richEvidenceCounts?: HarnessRichEvidenceCounts;
  finalizeThrows?: boolean;
} = {}) {
  const statesById = new Map(states.map((entry) => [entry.feed_item_id, clone(entry)]));
  const papersById = new Map(papers.map((entry) => [entry.id, clone(entry) as HarnessFeedItem]));
  const latestDigestGeneratedAtMs = new Date(latestDigestGeneratedAt).getTime();
  const recentDigestSourceItemIds = (now: Date) => {
    const recentDigestCutoffMs = now.getTime() - 72 * 60 * 60 * 1000;
    return latestDigestGeneratedAtMs >= recentDigestCutoffMs
      ? new Set(latestDigestSourceItemIds)
      : new Set<number>();
  };
  const availableEvidenceTableSet = new Set(availableEvidenceTables);
  const evidenceCountRows = (
    feedItemIds: number[],
    sourceHashes: Array<string | null | undefined>,
    key: HarnessRichEvidenceCountKey,
  ) =>
    feedItemIds.flatMap((feedItemId, index) => {
      const paperRow = papersById.get(feedItemId);
      const expectedSourceHash = sourceHashes[index];
      const configuredSourceHash = richEvidenceCounts[feedItemId]?.sourceHash ??
        (paperRow ? harnessEvidenceSourceHash(paperRow) : null);
      if (expectedSourceHash == null || expectedSourceHash !== configuredSourceHash) {
        return [];
      }
      const rowCount = richEvidenceCounts[feedItemId]?.[key] ?? 0;
      return rowCount > 0 ? [{ feed_item_id: feedItemId, row_count: rowCount }] : [];
    });
  const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(" ");

    if (text.includes("to_regclass('public.' || table_name)")) {
      return ((values[0] as string[]) ?? []).map((tableName) => ({
        table_name: tableName,
        exists: availableEvidenceTableSet.has(tableName),
      }));
    }

    if (
      text.includes("SELECT") &&
      text.includes("fi.id AS feed_item_id") &&
      text.includes("fi.full_text") &&
      text.includes("FROM feed_items fi") &&
      text.includes("fi.id = ANY")
    ) {
      const feedItemIds = (values[0] as number[]) ?? [];
      return feedItemIds.flatMap((feedItemId) => {
        const paperRow = papersById.get(feedItemId);
        return paperRow
          ? [{
              feed_item_id: paperRow.id,
              title: paperRow.title,
              content: paperRow.content,
              full_text: paperRow.full_text,
            }]
          : [];
      });
    }

    if (text.includes("JOIN paper_sections ps")) {
      const feedItemIds = (values[0] as number[]) ?? [];
      const sourceHashes = text.includes("pps.source_hash")
        ? feedItemIds.map((feedItemId) => statesById.get(feedItemId)?.source_hash)
        : ((values[1] as string[]) ?? []);
      return evidenceCountRows(feedItemIds, sourceHashes, "sectionCount");
    }

    if (text.includes("JOIN paper_evidence_spans pes")) {
      const feedItemIds = (values[0] as number[]) ?? [];
      const sourceHashes = text.includes("pps.source_hash")
        ? feedItemIds.map((feedItemId) => statesById.get(feedItemId)?.source_hash)
        : ((values[1] as string[]) ?? []);
      return evidenceCountRows(feedItemIds, sourceHashes, "spanCount");
    }

    if (text.includes("JOIN paper_evidence_cards pec")) {
      const feedItemIds = (values[0] as number[]) ?? [];
      const sourceHashes = text.includes("pps.source_hash")
        ? feedItemIds.map((feedItemId) => statesById.get(feedItemId)?.source_hash)
        : ((values[1] as string[]) ?? []);
      return evidenceCountRows(feedItemIds, sourceHashes, "cardCount");
    }

    if (text.includes("JOIN paper_reader_profiles prp")) {
      const feedItemIds = (values[0] as number[]) ?? [];
      const sourceHashes = text.includes("pps.source_hash")
        ? feedItemIds.map((feedItemId) => statesById.get(feedItemId)?.source_hash)
        : ((values[1] as string[]) ?? []);
      return evidenceCountRows(feedItemIds, sourceHashes, "profileCount");
    }

    if (
      text.includes("INSERT INTO paper_processing_state") &&
      text.includes("LEFT JOIN paper_processing_state pps") &&
      text.includes("pps.feed_item_id IS NULL")
    ) {
      const nowIso = String(values[0]);
      const limit = Number(values.at(-1) ?? 25);
      const inserted: Array<{ feed_item_id: number }> = [];
      const candidates = [...papersById.values()]
        .filter((entry) =>
          !statesById.has(entry.id) &&
          isPaperRichProcessingEligible(entry, new Date(nowIso))
        )
        .sort((a, b) => {
          const aTime = a.published_at ? new Date(a.published_at).getTime() : Number.NEGATIVE_INFINITY;
          const bTime = b.published_at ? new Date(b.published_at).getTime() : Number.NEGATIVE_INFINITY;
          return bTime - aTime || b.id - a.id;
        })
        .slice(0, limit);

      for (const paperRow of candidates) {
        const row = state({
          feed_item_id: paperRow.id,
          source_hash: null,
          full_text_status: paperRow.full_text?.trim() ? "succeeded" : "stale",
          deterministic_status: "pending",
          semantic_status: "pending",
          digest_ready: false,
          deterministic_next_run_at: nowIso,
          semantic_next_run_at: nowIso,
          updated_at: nowIso,
        });
        statesById.set(paperRow.id, row);
        inserted.push({ feed_item_id: paperRow.id });
      }
      return inserted;
    }

    if (
      text.includes("SELECT fi.id") &&
      text.includes("pendingTier") &&
      text.includes("ORDER BY fi.published_at DESC")
    ) {
      const now = new Date(String(values[0]));
      const limit = Number(values.at(-1) ?? 50);
      return [...papersById.values()]
        .filter((entry) =>
          entry.tier_metadata_json?.retention?.pendingTier === "hot_set" &&
          isPaperRichProcessingEligible(entry, now)
        )
        .sort((a, b) => {
          const aTime = a.published_at ? new Date(a.published_at).getTime() : Number.NEGATIVE_INFINITY;
          const bTime = b.published_at ? new Date(b.published_at).getTime() : Number.NEGATIVE_INFINITY;
          return bTime - aTime || b.id - a.id;
        })
        .slice(0, limit)
        .map((entry) => ({ id: entry.id }));
    }

    if (
      text.includes("SELECT *") &&
      text.includes("FROM paper_processing_state") &&
      text.includes("WHERE feed_item_id")
    ) {
      const id = Number(values[0]);
      const row = statesById.get(id);
      return row ? [clone(row)] : [];
    }

    if (
      text.includes("INSERT INTO paper_processing_state") &&
      !text.includes("WITH requested AS")
    ) {
      const id = Number(values[0]);
      if (statesById.has(id)) {
        return [];
      }
      const row = state({
        feed_item_id: id,
        source_hash: String(values[1]),
        full_text_status: values[2] as PaperProcessingState["full_text_status"],
        deterministic_next_run_at: String(values[3]),
        semantic_next_run_at: String(values[4]),
        created_at: String(values[3]),
        updated_at: String(values[3]),
      });
      statesById.set(id, row);
      return [clone(row)];
    }

    if (
      text.includes("UPDATE paper_processing_state") &&
      text.includes("deterministic_status = 'stale'")
    ) {
      const id = Number(values[7]);
      const row = statesById.get(id);
      if (!row) {
        return [];
      }
      const now = new Date(String(values[4]));
      const leaseActive =
        row.lease_token != null &&
        row.lease_expires_at != null &&
        new Date(row.lease_expires_at).getTime() > now.getTime();
      Object.assign(row, {
        source_hash: String(values[0]),
        evidence_quality: "unknown",
        full_text_status: values[1],
        deterministic_status: "stale",
        semantic_status: row.semantic_status === "skipped" ? "skipped" : "stale",
        digest_ready: false,
        deterministic_attempt_count: 0,
        semantic_attempt_count: 0,
        deterministic_next_run_at: String(values[2]),
        semantic_next_run_at: String(values[3]),
        lease_token: leaseActive ? row.lease_token : null,
        lease_expires_at: leaseActive ? row.lease_expires_at : null,
        deterministic_last_error: null,
        semantic_last_error: null,
        updated_at: String(values[6]),
      });
      return [clone(row)];
    }

    if (
      text.includes("WITH requested AS") &&
      text.includes("INSERT INTO paper_processing_state")
    ) {
      const feedItemIds = (values[0] as number[]) ?? [];
      const evidenceCounts = new Map(
        (JSON.parse(String(values[1])) as Array<{
          feedItemId: number;
          sectionCount: number;
          spanCount: number;
          cardCount: number;
          profileCount: number;
        }>).map((entry) => [entry.feedItemId, entry]),
      );
      const nowIso = String(
        values.find(
          (value) =>
            typeof value === "string" &&
            /^\d{4}-\d{2}-\d{2}T/.test(value) &&
            !Number.isNaN(new Date(value).getTime()),
        ),
      );
      const enqueued: Array<{ feed_item_id: number }> = [];
      for (const feedItemId of feedItemIds) {
        const paperRow = papersById.get(feedItemId);
        if (!paperRow || !isPaperRichProcessingEligible(paperRow, new Date(nowIso))) {
          continue;
        }
        const existing = statesById.get(feedItemId);
        const counts = evidenceCounts.get(feedItemId) ?? {
          sectionCount: 0,
          spanCount: 0,
          cardCount: 0,
          profileCount: 0,
        };
        const deterministicNeeded =
          !existing ||
          existing.source_hash == null ||
          existing.deterministic_status !== "succeeded" ||
          counts.sectionCount <= 0 ||
          counts.spanCount <= 0 ||
          counts.cardCount <= 0 ||
          counts.profileCount <= 0;
        const semanticNeeded =
          !existing ||
          existing.semantic_status !== "succeeded" ||
          existing.digest_ready !== true;
        if (!deterministicNeeded && !semanticNeeded) {
          continue;
        }
        if (
          existing?.lease_expires_at != null &&
          new Date(existing.lease_expires_at).getTime() >= new Date(nowIso).getTime()
        ) {
          continue;
        }

        const next = existing ?? state({ feed_item_id: feedItemId });
        if (deterministicNeeded) {
          Object.assign(next, {
            evidence_quality: "unknown",
            full_text_status: paperRow.full_text?.trim() ? "succeeded" : "stale",
            deterministic_status: "stale",
            digest_ready: false,
            deterministic_attempt_count: 0,
            deterministic_next_run_at: nowIso,
            deterministic_last_error: null,
          });
        }
        if (semanticNeeded || deterministicNeeded) {
          Object.assign(next, {
            semantic_status: "stale",
            semantic_attempt_count: 0,
            semantic_next_run_at: nowIso,
            semantic_last_error: null,
          });
        }
        Object.assign(next, {
          lease_token: null,
          lease_expires_at: null,
          updated_at: nowIso,
        });
        statesById.set(feedItemId, next);
        enqueued.push({ feed_item_id: feedItemId });
      }
      return enqueued;
    }

    if (
      text.includes("WITH requested AS") &&
      text.includes("UPDATE feed_items fi") &&
      text.includes("hotSetReadyAt")
    ) {
      if (finalizeThrows) {
        throw new Error("finalize failed");
      }
      const feedItemIds = (values[0] as number[]) ?? [];
      const evidenceCounts = new Map(
        (JSON.parse(String(values[1])) as Array<{
          feedItemId: number;
          sectionCount: number;
          spanCount: number;
          cardCount: number;
          profileCount: number;
        }>).map((entry) => [entry.feedItemId, entry]),
      );
      const lastScoredAt = String(values[2]);
      const nowIso = String(values[3] ?? values[2]);
      const finalized: Array<{ id: number }> = [];
      for (const feedItemId of feedItemIds) {
        const paperRow = papersById.get(feedItemId);
        const processingState = statesById.get(feedItemId);
        const counts = evidenceCounts.get(feedItemId) ?? {
          sectionCount: 0,
          spanCount: 0,
          cardCount: 0,
          profileCount: 0,
        };
        if (
          paperRow?.source_type !== "paper" ||
          paperRow.tier_metadata_json?.retention?.pendingTier !== "hot_set" ||
          !isPaperRichProcessingEligible(paperRow, new Date(nowIso)) ||
          !isPendingHotSetFinalizationAllowed(paperRow, new Date(nowIso)) ||
          processingState?.deterministic_status !== "succeeded" ||
          processingState.semantic_status !== "succeeded" ||
          processingState.digest_ready !== true ||
          counts.sectionCount <= 0 ||
          counts.spanCount <= 0 ||
          counts.cardCount <= 0 ||
          counts.profileCount <= 0
        ) {
          continue;
        }

        const retention = { ...(paperRow.tier_metadata_json?.retention ?? {}) };
        const pendingReviewRunId = retention.pendingReviewRunId as number | undefined;
        const pendingReviewAction = retention.pendingReviewAction as string | undefined;
        delete retention.pendingTier;
        delete retention.pendingSourceTier;
        delete retention.pendingReviewRunId;
        delete retention.pendingReviewAction;
        delete retention.pendingReviewStartedAt;
        delete retention.pendingReviewReasons;
        paperRow.corpus_tier = "hot_set";
        paperRow.hot_set_reason =
          paperRow.hot_set_reason ?? "rich processing complete for pending Hot Set promotion";
        paperRow.archive_reason = null;
        paperRow.last_scored_at = paperRow.last_scored_at ?? lastScoredAt;
        paperRow.tier_metadata_json = {
          ...(paperRow.tier_metadata_json ?? {}),
          lastReviewAction: pendingReviewAction ?? "pending_to_hot_set",
          retention: {
            ...retention,
            hotSetReadyAt: nowIso,
            hotSetReadyReviewRunId: pendingReviewRunId ?? null,
          },
        };
        finalized.push({ id: feedItemId });
      }
      return finalized;
    }

    if (
      text.includes("UPDATE paper_processing_state pps") &&
      text.includes("semantic_status = 'stale'") &&
      text.includes("pendingTier")
    ) {
      const id = Number(values[3]);
      const row = statesById.get(id);
      const paperRow = papersById.get(id);
      if (
        !row ||
        paperRow?.source_type !== "paper" ||
        paperRow.tier_metadata_json?.retention?.pendingTier !== "hot_set" ||
        !isPendingHotSetFinalizationAllowed(paperRow, new Date(String(values[4] ?? values[2]))) ||
        row.semantic_status !== "succeeded"
      ) {
        return [];
      }
      Object.assign(row, {
        semantic_status: "stale",
        digest_ready: false,
        semantic_next_run_at: String(values[0]),
        semantic_last_error: String(values[1]),
        lease_token: null,
        lease_expires_at: null,
        updated_at: String(values[2]),
      });
      return [clone(row)];
    }

    if (
      text.includes("WITH candidate AS") &&
      values.length > 6 &&
      typeof values[0] === "number" &&
      text.includes("WHERE pps.feed_item_id =") &&
      text.includes("semantic_status = 'running'")
    ) {
      const feedItemId = Number(values[0]);
      const now = new Date(String(values[1]));
      const leaseToken = String(values.at(-4));
      const leaseExpiresAt = String(values.at(-3));
      const candidate = statesById.get(feedItemId);
      const paperRow = papersById.get(feedItemId);
      if (
        !candidate ||
        paperRow?.source_type !== "paper" ||
        !isPaperRichProcessingEligible(paperRow, now) ||
        candidate.deterministic_status !== "succeeded" ||
        !["pending", "failed", "stale", "running", "skipped"].includes(
          candidate.semantic_status,
        ) ||
        candidate.semantic_attempt_count >= PAPER_SEMANTIC_MAX_ATTEMPTS ||
        new Date(candidate.semantic_next_run_at).getTime() > now.getTime() ||
        (
          candidate.lease_expires_at != null &&
          new Date(candidate.lease_expires_at).getTime() >= now.getTime()
        )
      ) {
        return [];
      }
      candidate.semantic_status = "running";
      candidate.digest_ready = false;
      candidate.lease_token = leaseToken;
      candidate.lease_expires_at = leaseExpiresAt;
      candidate.last_started_at = String(values.at(-2));
      candidate.updated_at = String(values.at(-1));
      return [
        {
          ...clone(candidate),
          paper_id: paperRow.id,
          paper_external_id: paperRow.external_id,
          paper_source_type: paperRow.source_type,
          paper_title: paperRow.title,
          paper_content: paperRow.content,
          paper_url: paperRow.url,
          paper_author_name: paperRow.author_name,
          paper_author_handle: paperRow.author_handle,
          paper_published_at: paperRow.published_at,
          paper_corpus_tier: paperRow.corpus_tier ?? null,
          paper_meta: paperRow.paper_meta,
          paper_tier_metadata_json: paperRow.tier_metadata_json ?? null,
          paper_full_text: paperRow.full_text ?? null,
          paper_full_text_source: paperRow.full_text_source ?? null,
        },
      ];
    }

    if (
      text.includes("candidate AS") &&
      text.includes("semantic_status = 'running'")
    ) {
      const now = new Date(String(values[0]));
      const freshFetchedCutoffMs = now.getTime() - 24 * 60 * 60 * 1000;
      const recentDigestSourceItemIdsSet = recentDigestSourceItemIds(now);
      const leaseToken = String(values.at(-4));
      const leaseExpiresAt = String(values.at(-3));
      const candidates = [...statesById.values()]
        .filter((entry) => {
          const paperRow = papersById.get(entry.feed_item_id);
          if (paperRow?.source_type !== "paper") {
            return false;
          }
          if (!isPaperRichProcessingEligible(paperRow, now)) {
            return false;
          }
          if (entry.deterministic_status !== "succeeded") {
            return false;
          }
          const fetchedAt = paperRow.fetched_at
            ? new Date(paperRow.fetched_at).getTime()
            : Number.NEGATIVE_INFINITY;
          if (fetchedAt <= freshFetchedCutoffMs) {
            return false;
          }
          if (recentDigestSourceItemIdsSet.has(entry.feed_item_id)) {
            return false;
          }
          if (
            !["pending", "failed", "stale", "running", "skipped"].includes(
              entry.semantic_status,
            )
          ) {
            return false;
          }
          if (entry.semantic_attempt_count >= PAPER_SEMANTIC_MAX_ATTEMPTS) {
            return false;
          }
          if (new Date(entry.semantic_next_run_at).getTime() > now.getTime()) {
            return false;
          }
          return (
            entry.lease_expires_at == null ||
            new Date(entry.lease_expires_at).getTime() < now.getTime()
          );
        })
        .sort((a, b) => {
          const statusRank = (status: PaperProcessingState["semantic_status"]) => {
            if (status === "pending" || status === "stale") {
              return 0;
            }
            if (status === "running") {
              return 1;
            }
            if (status === "failed") {
              return 2;
            }
            return 3;
          };
          const statusDelta = statusRank(a.semantic_status) - statusRank(b.semantic_status);
          if (statusDelta !== 0) {
            return statusDelta;
          }
          const aPaper = papersById.get(a.feed_item_id)!;
          const bPaper = papersById.get(b.feed_item_id)!;
          const aTime = aPaper.published_at
            ? new Date(aPaper.published_at).getTime()
            : Number.NEGATIVE_INFINITY;
          const bTime = bPaper.published_at
            ? new Date(bPaper.published_at).getTime()
            : Number.NEGATIVE_INFINITY;
          return bTime - aTime || b.feed_item_id - a.feed_item_id;
        });
      const claimed = candidates[0];
      if (!claimed) {
        return [];
      }
      claimed.semantic_status = "running";
      claimed.digest_ready = false;
      claimed.lease_token = leaseToken;
      claimed.lease_expires_at = leaseExpiresAt;
      claimed.last_started_at = String(values.at(-2));
      claimed.updated_at = String(values.at(-1));
      const paperRow = papersById.get(claimed.feed_item_id)!;
      return [
        {
          ...clone(claimed),
          paper_id: paperRow.id,
          paper_external_id: paperRow.external_id,
          paper_source_type: paperRow.source_type,
          paper_title: paperRow.title,
          paper_content: paperRow.content,
          paper_url: paperRow.url,
          paper_author_name: paperRow.author_name,
          paper_author_handle: paperRow.author_handle,
          paper_published_at: paperRow.published_at,
          paper_corpus_tier: paperRow.corpus_tier ?? null,
          paper_meta: paperRow.paper_meta,
          paper_tier_metadata_json: paperRow.tier_metadata_json ?? null,
          paper_full_text: paperRow.full_text ?? null,
          paper_full_text_source: paperRow.full_text_source ?? null,
        },
      ];
    }

    if (
      text.includes("WITH candidate AS") &&
      values.length > 6 &&
      typeof values[0] === "number" &&
      text.includes("WHERE pps.feed_item_id =")
    ) {
      const feedItemId = Number(values[0]);
      const now = new Date(String(values[1]));
      const leaseToken = String(values.at(-4));
      const leaseExpiresAt = String(values.at(-3));
      const candidate = statesById.get(feedItemId);
      const paperRow = papersById.get(feedItemId);
      if (
        !candidate ||
        paperRow?.source_type !== "paper" ||
        !isPaperRichProcessingEligible(paperRow, now) ||
        !["pending", "failed", "stale", "running"].includes(
          candidate.deterministic_status,
        ) ||
        new Date(candidate.deterministic_next_run_at).getTime() > now.getTime() ||
        (
          candidate.lease_expires_at != null &&
          new Date(candidate.lease_expires_at).getTime() >= now.getTime()
        )
      ) {
        return [];
      }
      candidate.deterministic_status = "running";
      candidate.lease_token = leaseToken;
      candidate.lease_expires_at = leaseExpiresAt;
      candidate.last_started_at = String(values.at(-2));
      candidate.updated_at = String(values.at(-1));
      return [
        {
          ...clone(candidate),
          paper_id: paperRow.id,
          paper_external_id: paperRow.external_id,
          paper_source_type: paperRow.source_type,
          paper_title: paperRow.title,
          paper_content: paperRow.content,
          paper_url: paperRow.url,
          paper_author_name: paperRow.author_name,
          paper_author_handle: paperRow.author_handle,
          paper_published_at: paperRow.published_at,
          paper_corpus_tier: paperRow.corpus_tier ?? null,
          paper_meta: paperRow.paper_meta,
          paper_tier_metadata_json: paperRow.tier_metadata_json ?? null,
          paper_full_text: paperRow.full_text ?? null,
          paper_full_text_source: paperRow.full_text_source ?? null,
        },
      ];
    }

    if (text.includes("WITH candidate AS")) {
      const now = new Date(String(values[0]));
      const leaseToken = String(values.at(-4));
      const leaseExpiresAt = String(values.at(-3));
      const candidates = [...statesById.values()]
        .filter((entry) => {
          const paperRow = papersById.get(entry.feed_item_id);
          if (paperRow?.source_type !== "paper") {
            return false;
          }
          if (!isPaperRichProcessingEligible(paperRow, now)) {
            return false;
          }
          if (
            !["pending", "failed", "stale", "running"].includes(
              entry.deterministic_status,
            )
          ) {
            return false;
          }
          if (new Date(entry.deterministic_next_run_at).getTime() > now.getTime()) {
            return false;
          }
          return (
            entry.lease_expires_at == null ||
            new Date(entry.lease_expires_at).getTime() < now.getTime()
          );
        })
        .sort((a, b) => {
          const aPaper = papersById.get(a.feed_item_id)!;
          const bPaper = papersById.get(b.feed_item_id)!;
          const aTime = aPaper.published_at
            ? new Date(aPaper.published_at).getTime()
            : Number.NEGATIVE_INFINITY;
          const bTime = bPaper.published_at
            ? new Date(bPaper.published_at).getTime()
            : Number.NEGATIVE_INFINITY;
          return bTime - aTime || b.feed_item_id - a.feed_item_id;
        });
      const claimed = candidates[0];
      if (!claimed) {
        return [];
      }
      claimed.deterministic_status = "running";
      claimed.lease_token = leaseToken;
      claimed.lease_expires_at = leaseExpiresAt;
      claimed.last_started_at = String(values.at(-2));
      claimed.updated_at = String(values.at(-1));
      const paperRow = papersById.get(claimed.feed_item_id)!;
      return [
        {
          ...clone(claimed),
          paper_id: paperRow.id,
          paper_external_id: paperRow.external_id,
          paper_source_type: paperRow.source_type,
          paper_title: paperRow.title,
          paper_content: paperRow.content,
          paper_url: paperRow.url,
          paper_author_name: paperRow.author_name,
          paper_author_handle: paperRow.author_handle,
          paper_published_at: paperRow.published_at,
          paper_corpus_tier: paperRow.corpus_tier ?? null,
          paper_meta: paperRow.paper_meta,
          paper_tier_metadata_json: paperRow.tier_metadata_json ?? null,
          paper_full_text: paperRow.full_text ?? null,
          paper_full_text_source: paperRow.full_text_source ?? null,
        },
      ];
    }

    if (
      text.includes("SELECT deterministic_attempt_count") &&
      text.includes("FROM paper_processing_state")
    ) {
      const id = Number(values[0]);
      const row = statesById.get(id);
      return row
        ? [{ deterministic_attempt_count: row.deterministic_attempt_count }]
        : [];
    }

    if (
      text.includes("SELECT semantic_attempt_count") &&
      text.includes("FROM paper_processing_state")
    ) {
      const id = Number(values[0]);
      const row = statesById.get(id);
      return row
        ? [{ semantic_attempt_count: row.semantic_attempt_count }]
        : [];
    }

    if (
      text.includes("UPDATE paper_processing_state") &&
      text.includes("SET source_hash") &&
      text.includes("deterministic_status = 'succeeded'")
    ) {
      const id = Number(values[7]);
      const row = statesById.get(id);
      const expectedLeaseToken = values[8] as string | null;
      const expectedSourceHash = values[10] as string | null;
      if (
        !row ||
        (expectedLeaseToken != null && row.lease_token !== expectedLeaseToken) ||
        (expectedSourceHash != null && row.source_hash !== expectedSourceHash)
      ) {
        return [];
      }
      Object.assign(row, {
        source_hash: String(values[0]),
        evidence_quality: values[1],
        full_text_status: values[2],
        deterministic_status: "succeeded",
        semantic_status: "pending",
        digest_ready: false,
        deterministic_attempt_count: 0,
        semantic_attempt_count: 0,
        deterministic_next_run_at: String(values[3]),
        semantic_next_run_at: String(values[4]),
        lease_token: null,
        lease_expires_at: null,
        deterministic_last_error: null,
        semantic_last_error: null,
        last_success_at: String(values[5]),
        updated_at: String(values[6]),
      });
      return [clone(row)];
    }

    if (
      text.includes("UPDATE paper_processing_state") &&
      text.includes("SET semantic_status = 'succeeded'")
    ) {
      const id = Number(values[3]);
      const row = statesById.get(id);
      const expectedLeaseToken = values[4] as string | null;
      const expectedSourceHash = values[6] as string | null;
      if (
        !row ||
        (expectedLeaseToken != null && row.lease_token !== expectedLeaseToken) ||
        (expectedSourceHash != null && row.source_hash !== expectedSourceHash)
      ) {
        return [];
      }
      Object.assign(row, {
        semantic_status: "succeeded",
        digest_ready: true,
        semantic_attempt_count: 0,
        semantic_next_run_at: String(values[0]),
        lease_token: null,
        lease_expires_at: null,
        semantic_last_error: null,
        last_success_at: String(values[1]),
        updated_at: String(values[2]),
      });
      return [clone(row)];
    }

    if (
      text.includes("UPDATE paper_processing_state") &&
      text.includes("deterministic_status = 'dead'")
    ) {
      const id = Number(values[6]);
      const row = statesById.get(id);
      if (!row) {
        return [];
      }
      Object.assign(row, {
        deterministic_status: "dead",
        digest_ready: false,
        deterministic_attempt_count: Number(values[0]),
        deterministic_next_run_at: String(values[1]),
        full_text_status: values[2] ?? row.full_text_status,
        deterministic_last_error: String(values[3]),
        lease_token: null,
        lease_expires_at: null,
        last_failed_at: String(values[4]),
        updated_at: String(values[5]),
      });
      return [{ deterministic_attempt_count: row.deterministic_attempt_count }];
    }

    if (
      text.includes("UPDATE paper_processing_state") &&
      text.includes("semantic_status = 'dead'")
    ) {
      const id = Number(values[5]);
      const row = statesById.get(id);
      if (!row) {
        return [];
      }
      Object.assign(row, {
        semantic_status: "dead",
        digest_ready: false,
        semantic_attempt_count: Number(values[0]),
        semantic_next_run_at: String(values[1]),
        semantic_last_error: String(values[2]),
        lease_token: null,
        lease_expires_at: null,
        last_failed_at: String(values[3]),
        updated_at: String(values[4]),
      });
      if (text.includes("RETURNING *")) {
        return [clone(row)];
      }
      return [{ semantic_attempt_count: row.semantic_attempt_count }];
    }

    if (
      text.includes("UPDATE paper_processing_state") &&
      text.includes("deterministic_status = 'failed'")
    ) {
      const id = Number(values[6]);
      const row = statesById.get(id);
      if (!row) {
        return [];
      }
      Object.assign(row, {
        deterministic_status: "failed",
        digest_ready: false,
        deterministic_attempt_count: Number(values[0]),
        deterministic_next_run_at: String(values[1]),
        full_text_status: values[2] ?? row.full_text_status,
        deterministic_last_error: String(values[3]),
        lease_token: null,
        lease_expires_at: null,
        last_failed_at: String(values[4]),
        updated_at: String(values[5]),
      });
      return [{ deterministic_attempt_count: row.deterministic_attempt_count }];
    }

    if (
      text.includes("UPDATE paper_processing_state") &&
      text.includes("semantic_status = 'failed'")
    ) {
      const id = Number(values[5]);
      const row = statesById.get(id);
      if (!row) {
        return [];
      }
      Object.assign(row, {
        semantic_status: "failed",
        digest_ready: false,
        semantic_attempt_count: Number(values[0]),
        semantic_next_run_at: String(values[1]),
        semantic_last_error: String(values[2]),
        lease_token: null,
        lease_expires_at: null,
        last_failed_at: String(values[3]),
        updated_at: String(values[4]),
      });
      if (text.includes("RETURNING *")) {
        return [clone(row)];
      }
      return [{ semantic_attempt_count: row.semantic_attempt_count }];
    }

    return [];
  });

  return {
    sql,
    stateFor(id: number) {
      return statesById.get(id);
    },
    paperFor(id: number) {
      return papersById.get(id);
    },
  };
}

describe("paper processing state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates pending state for a new paper", async () => {
    const harness = createSqlHarness();

    const result = await ensurePaperProcessingStateForFeedItem(
      harness.sql as never,
      paper(),
      NOW,
    );

    expect(result.action).toBe("created");
    expect(result.state).toMatchObject({
      feed_item_id: 101,
      deterministic_status: "pending",
      semantic_status: "pending",
      full_text_status: "pending",
      digest_ready: false,
    });
    expect(result.sourceHash).toEqual(computePaperProcessingSourceHash(paper()));
  });

  it("leaves unchanged hashes ready without reprocessing", async () => {
    const item = paper();
    const sourceHash = computePaperProcessingSourceHash(item);
    const harness = createSqlHarness({
      states: [
        state({
          source_hash: sourceHash,
          deterministic_status: "succeeded",
          semantic_status: "pending",
          digest_ready: true,
        }),
      ],
    });

    const result = await ensurePaperProcessingStateForFeedItem(
      harness.sql as never,
      item,
      NOW,
    );

    expect(result.action).toBe("unchanged");
    expect(result.state).toMatchObject({
      deterministic_status: "succeeded",
      digest_ready: true,
    });
    expect(
      harness.sql.mock.calls.some((call) =>
        call[0].join(" ").includes("deterministic_status = 'stale'"),
      ),
    ).toBe(false);
  });

  it("marks changed hashes stale and clears digest readiness", async () => {
    const oldItem = paper({ content: "old abstract" });
    const newItem = paper({ content: "new abstract with a new result" });
    const harness = createSqlHarness({
      states: [
        state({
          source_hash: computePaperProcessingSourceHash(oldItem),
          deterministic_status: "succeeded",
          semantic_status: "succeeded",
          digest_ready: true,
        }),
      ],
    });

    const result = await ensurePaperProcessingStateForFeedItem(
      harness.sql as never,
      newItem,
      NOW,
    );

    expect(result.action).toBe("stale");
    expect(result.state).toMatchObject({
      source_hash: computePaperProcessingSourceHash(newItem),
      deterministic_status: "stale",
      semantic_status: "stale",
      full_text_status: "stale",
      digest_ready: false,
      deterministic_attempt_count: 0,
    });
  });

  it("marks changed hashes stale without clearing an active lease", async () => {
    const oldItem = paper({ content: "old abstract" });
    const newItem = paper({ content: "new abstract with a new result" });
    const harness = createSqlHarness({
      papers: [newItem],
      states: [
        state({
          source_hash: computePaperProcessingSourceHash(oldItem),
          deterministic_status: "running",
          semantic_status: "pending",
          digest_ready: false,
          lease_token: "active-token",
          lease_expires_at: "2026-05-22T12:05:00.000Z",
        }),
      ],
    });

    const result = await ensurePaperProcessingStateForFeedItem(
      harness.sql as never,
      newItem,
      NOW,
    );
    const reclaimed = await claimNextDeterministicPaper(harness.sql as never, {
      now: NOW,
      leaseToken: "new-token",
    });

    expect(result.action).toBe("stale");
    expect(result.state).toMatchObject({
      source_hash: computePaperProcessingSourceHash(newItem),
      deterministic_status: "stale",
      lease_token: "active-token",
      lease_expires_at: "2026-05-22T12:05:00.000Z",
    });
    expect(reclaimed).toBeNull();
  });

  it("reclaims an expired deterministic lease", async () => {
    const harness = createSqlHarness({
      papers: [paper()],
      states: [
        state({
          deterministic_status: "failed",
          lease_token: "old-token",
          lease_expires_at: "2026-05-22T11:59:00.000Z",
        }),
      ],
    });

    const claim = await claimNextDeterministicPaper(harness.sql as never, {
      now: NOW,
      leaseToken: "new-token",
    });

    expect(claim?.paper.id).toBe(101);
    expect(claim?.leaseToken).toBe("new-token");
    expect(harness.stateFor(101)).toMatchObject({
      deterministic_status: "running",
      lease_token: "new-token",
    });
  });

  it("carries paper tier metadata on deterministic claims", async () => {
    const tierMetadata = {
      pinned: true,
      notes: ["keep override"],
      signals: { owner: "manual-review" },
    };
    const harness = createSqlHarness({
      papers: [paper({ tier_metadata_json: tierMetadata })],
      states: [
        state({
          deterministic_status: "pending",
        }),
      ],
    });

    const claim = await claimNextDeterministicPaper(harness.sql as never, {
      now: NOW,
      leaseToken: "new-token",
    });

    expect(claim?.paper.tier_metadata_json).toEqual(tierMetadata);
  });

  it("claims hot-set promotions that have been marked stale", async () => {
    const promotedPaper = paper({
      corpus_tier: "hot_set",
      tier_metadata_json: {
        lastReviewAction: "archive_to_hot_set",
      },
    });
    const harness = createSqlHarness({
      papers: [promotedPaper],
      states: [
        state({
          deterministic_status: "stale",
          semantic_status: "stale",
          digest_ready: false,
        }),
      ],
    });

    const claim = await claimNextDeterministicPaper(harness.sql as never, {
      now: NOW,
      leaseToken: "promotion-token",
    });

    expect(claim?.paper.id).toBe(101);
    expect(claim?.paper.corpus_tier).toBe("hot_set");
    expect(harness.stateFor(101)).toMatchObject({
      deterministic_status: "running",
      lease_token: "promotion-token",
    });
  });

  it("does not claim archive papers for deterministic rich rebuilds", async () => {
    const harness = createSqlHarness({
      papers: [paper({ corpus_tier: "archive" })],
      states: [
        state({
          deterministic_status: "pending",
          digest_ready: false,
        }),
      ],
    });

    const claim = await claimNextDeterministicPaper(harness.sql as never, {
      now: NOW,
      leaseToken: "archive-token",
    });

    expect(claim).toBeNull();
    expect(harness.stateFor(101)).toMatchObject({
      deterministic_status: "pending",
      lease_token: null,
    });
  });

  it("does not claim archive papers for semantic rich rebuilds", async () => {
    const harness = createSqlHarness({
      papers: [
        paper({
          corpus_tier: "archive",
          fetched_at: "2026-05-22T11:00:00.000Z",
        }),
      ],
      states: [
        state({
          deterministic_status: "succeeded",
          semantic_status: "pending",
          digest_ready: true,
        }),
      ],
    });

    const claim = await claimNextSemanticPaper(harness.sql as never, {
      now: NOW,
      leaseToken: "archive-semantic-token",
    });

    expect(claim).toBeNull();
    expect(harness.stateFor(101)).toMatchObject({
      semantic_status: "pending",
      lease_token: null,
    });
  });

  it("does not reclaim pruned archive papers solely because rich rows are missing", async () => {
    const prunedArchive = paper({
      corpus_tier: "archive",
      tier_metadata_json: {
        retention: {
          richEvidencePrunedAt: "2026-05-24T12:00:00.000Z",
        },
      },
      full_text: "Full text was retained even though derived rich evidence was pruned.",
      full_text_source: "arxiv_html",
    });
    const harness = createSqlHarness({
      papers: [prunedArchive],
      states: [
        state({
          deterministic_status: "stale",
          semantic_status: "stale",
          digest_ready: false,
        }),
      ],
      richEvidenceCounts: {
        101: {
          sectionCount: 0,
          spanCount: 0,
          cardCount: 0,
          profileCount: 0,
        },
      },
    });

    expect(isPaperRichProcessingEligible(prunedArchive)).toBe(false);

    const deterministicClaim = await claimNextDeterministicPaper(harness.sql as never, {
      now: NOW,
      leaseToken: "pruned-archive-deterministic-token",
    });
    const semanticClaim = await claimNextSemanticPaper(harness.sql as never, {
      now: NOW,
      leaseToken: "pruned-archive-semantic-token",
    });

    expect(deterministicClaim).toBeNull();
    expect(semanticClaim).toBeNull();
    expect(harness.stateFor(101)).toMatchObject({
      deterministic_status: "stale",
      semantic_status: "stale",
      lease_token: null,
    });
  });

  it("keeps manually pinned archive papers eligible for rich processing", async () => {
    const harness = createSqlHarness({
      papers: [
        paper({
          corpus_tier: "archive",
          tier_metadata_json: { pinned: true },
        }),
      ],
      states: [
        state({
          deterministic_status: "pending",
        }),
      ],
    });

    const claim = await claimNextDeterministicPaper(harness.sql as never, {
      now: NOW,
      leaseToken: "pinned-token",
    });

    expect(claim?.paper.id).toBe(101);
    expect(claim?.paper.tier_metadata_json).toEqual({ pinned: true });
    expect(harness.stateFor(101)).toMatchObject({
      deterministic_status: "running",
      lease_token: "pinned-token",
    });
  });

  it("preserves manual archive and ignored controls in claim eligibility", async () => {
    expect(
      isPaperRichProcessingEligible(
        paper({
          corpus_tier: "hot_set",
          tier_metadata_json: { manualTier: "archive" },
        }),
      ),
    ).toBe(false);
    expect(
      isPaperRichProcessingEligible(
        paper({
          corpus_tier: "hot_set",
          tier_metadata_json: { ignored: true, pinned: true },
        }),
      ),
    ).toBe(false);
    expect(
      isPaperRichProcessingEligible(
        paper({
          corpus_tier: "ignored",
          tier_metadata_json: {
            retention: {
              pendingTier: "hot_set",
            },
          },
        }),
      ),
    ).toBe(false);

    const harness = createSqlHarness({
      papers: [
        paper({
          corpus_tier: "hot_set",
          tier_metadata_json: { manualTier: "archive" },
        }),
      ],
      states: [
        state({
          deterministic_status: "pending",
        }),
      ],
    });

    const claim = await claimNextDeterministicPaper(harness.sql as never, {
      now: NOW,
      leaseToken: "manual-archive-token",
    });

    expect(claim).toBeNull();
    expect(harness.stateFor(101)?.lease_token).toBeNull();
  });

  it("keeps pending hot-set promotions eligible before the tier flips", async () => {
    const pendingPromotion = paper({
      corpus_tier: "archive",
      tier_metadata_json: {
        retention: {
          pendingTier: "hot_set",
          pendingReviewAction: "archive_to_hot_set",
          pendingReviewRunId: 77,
        },
      },
    });
    const harness = createSqlHarness({
      papers: [pendingPromotion],
      states: [
        state({
          deterministic_status: "pending",
          digest_ready: false,
        }),
      ],
    });

    expect(isPaperRichProcessingEligible(pendingPromotion)).toBe(true);

    const claim = await claimNextDeterministicPaper(harness.sql as never, {
      now: NOW,
      leaseToken: "pending-token",
    });

    expect(claim?.paper.id).toBe(101);
    expect(claim?.paper.corpus_tier).toBe("archive");
    expect(harness.stateFor(101)).toMatchObject({
      deterministic_status: "running",
      lease_token: "pending-token",
    });
  });

  it("does not claim expired intake pending hot-set rows without a new review promotion", async () => {
    const expiredDeterministic = paper({
      id: 201,
      external_id: "2605.expired-intake-deterministic",
      corpus_tier: "archive",
      tier_metadata_json: {
        retention: {
          intakeDefaultTier: "hot_set",
          selectedAt: "2026-05-01T00:00:00.000Z",
          graceDays: 14,
          pendingTier: "hot_set",
          pendingSourceTier: "archive",
          pendingReviewAction: "intake_to_hot_set",
          pendingReviewStartedAt: "2026-05-01T00:00:00.000Z",
        },
      },
    });
    const expiredSemantic = paper({
      ...expiredDeterministic,
      id: 202,
      external_id: "2605.expired-intake-semantic",
    });
    const harness = createSqlHarness({
      papers: [expiredDeterministic, expiredSemantic],
      states: [
        state({
          feed_item_id: 201,
          deterministic_status: "pending",
          semantic_status: "pending",
        }),
        state({
          feed_item_id: 202,
          deterministic_status: "succeeded",
          semantic_status: "pending",
          digest_ready: false,
        }),
      ],
    });

    expect(isPendingHotSetFinalizationAllowed(expiredDeterministic, NOW)).toBe(false);
    expect(isPaperRichProcessingEligible(expiredDeterministic, NOW)).toBe(false);

    const deterministicClaim = await claimNextDeterministicPaper(harness.sql as never, {
      now: NOW,
      leaseToken: "expired-deterministic-token",
    });
    const semanticClaim = await claimNextSemanticPaper(harness.sql as never, {
      now: NOW,
      leaseToken: "expired-semantic-token",
    });

    expect(deterministicClaim).toBeNull();
    expect(semanticClaim).toBeNull();
    expect(harness.stateFor(201)?.lease_token).toBeNull();
    expect(harness.stateFor(202)?.lease_token).toBeNull();
  });

  it("repairs missing processing state for pending hot-set papers before claiming", async () => {
    const pendingIntake = paper({
      corpus_tier: "archive",
      tier_metadata_json: {
        retention: {
          intakeDefaultTier: "hot_set",
          selectedAt: NOW.toISOString(),
          graceDays: 14,
          pendingTier: "hot_set",
          pendingReviewAction: "intake_to_hot_set",
        },
      },
    });
    const harness = createSqlHarness({
      papers: [pendingIntake],
      states: [],
    });

    const claim = await claimNextDeterministicPaper(harness.sql as never, {
      now: NOW,
      leaseToken: "repaired-token",
    });

    expect(claim?.paper.id).toBe(101);
    expect(claim?.paper.corpus_tier).toBe("archive");
    expect(harness.stateFor(101)).toMatchObject({
      source_hash: null,
      deterministic_status: "running",
      semantic_status: "pending",
      digest_ready: false,
      lease_token: "repaired-token",
    });
  });

  it("enqueues promoted hot-set papers with missing rich state only", async () => {
    const promotedPaper = paper({
      id: 201,
      external_id: "2605.promoted",
      corpus_tier: "hot_set",
      tier_metadata_json: {
        lastReviewAction: "archive_to_hot_set",
      },
    });
    const archivePaper = paper({
      id: 202,
      external_id: "2605.archive",
      corpus_tier: "archive",
    });
    const harness = createSqlHarness({
      papers: [promotedPaper, archivePaper],
      states: [
        state({
          feed_item_id: 201,
          source_hash: null,
          deterministic_status: "succeeded",
          semantic_status: "succeeded",
          digest_ready: true,
        }),
        state({
          feed_item_id: 202,
          source_hash: null,
          deterministic_status: "succeeded",
          semantic_status: "succeeded",
          digest_ready: true,
        }),
      ],
    });

    const enqueued = await enqueueHotSetProcessingForFeedItems(
      harness.sql as never,
      [201, 202],
      NOW,
    );
    const claim = await claimNextDeterministicPaper(harness.sql as never, {
      now: NOW,
      leaseToken: "enqueued-token",
    });

    expect(enqueued).toEqual({
      requestedFeedItemIds: [201, 202],
      enqueuedFeedItemIds: [201],
      enqueuedCount: 1,
      finalizedFeedItemIds: [],
      finalizedCount: 0,
    });
    expect(harness.stateFor(201)).toMatchObject({
      deterministic_status: "running",
      semantic_status: "stale",
      digest_ready: false,
      lease_token: "enqueued-token",
    });
    expect(harness.stateFor(202)).toMatchObject({
      deterministic_status: "succeeded",
      semantic_status: "succeeded",
      digest_ready: true,
      lease_token: null,
    });
    expect(claim?.paper.id).toBe(201);
  });

  it("skips optional evidence count queries when rich evidence tables are absent", async () => {
    const promotedPaper = paper({
      id: 201,
      external_id: "2605.promoted",
      corpus_tier: "hot_set",
    });
    const harness = createSqlHarness({
      papers: [promotedPaper],
      availableEvidenceTables: [],
      states: [
        state({
          feed_item_id: 201,
          source_hash: null,
          deterministic_status: "succeeded",
          semantic_status: "succeeded",
          digest_ready: true,
        }),
      ],
    });

    const enqueued = await enqueueHotSetProcessingForFeedItems(
      harness.sql as never,
      [201],
      NOW,
    );

    expect(enqueued).toMatchObject({
      enqueuedFeedItemIds: [201],
      enqueuedCount: 1,
    });
    expect(
      harness.sql.mock.calls.some((call) =>
        call[0].join(" ").includes("JOIN paper_sections ps") ||
        call[0].join(" ").includes("JOIN paper_evidence_spans pes") ||
        call[0].join(" ").includes("JOIN paper_evidence_cards pec") ||
        call[0].join(" ").includes("JOIN paper_reader_profiles prp"),
      ),
    ).toBe(false);
  });

  it("does not enqueue hot-set papers with complete rich evidence counts", async () => {
    const promotedPaper = paper({
      id: 201,
      external_id: "2605.complete",
      corpus_tier: "hot_set",
    });
    const harness = createSqlHarness({
      papers: [promotedPaper],
      richEvidenceCounts: {
        201: {
          sectionCount: 2,
          spanCount: 3,
          cardCount: 1,
          profileCount: 1,
        },
      },
      states: [
        state({
          feed_item_id: 201,
          source_hash: "current-hash",
          deterministic_status: "succeeded",
          semantic_status: "succeeded",
          digest_ready: true,
        }),
      ],
    });

    const enqueued = await enqueueHotSetProcessingForFeedItems(
      harness.sql as never,
      [201],
      NOW,
    );

    expect(enqueued).toEqual({
      requestedFeedItemIds: [201],
      enqueuedFeedItemIds: [],
      enqueuedCount: 0,
      finalizedFeedItemIds: [],
      finalizedCount: 0,
    });
    expect(harness.stateFor(201)).toMatchObject({
      deterministic_status: "succeeded",
      semantic_status: "succeeded",
      digest_ready: true,
      lease_token: null,
    });
  });

  it("finalizes pending hot-set promotions only when rich processing is complete", async () => {
    const pendingPromotion = paper({
      id: 201,
      external_id: "2605.pending",
      corpus_tier: "archive",
      tier_metadata_json: {
        lastReviewAction: "archive_to_pending_hot_set",
        retention: {
          pendingTier: "hot_set",
          pendingReviewAction: "archive_to_hot_set",
          pendingReviewRunId: 77,
          pendingReviewReasons: ["popular paper"],
        },
      },
    });
    const evidenceSourceHash = harnessEvidenceSourceHash(pendingPromotion);
    const harness = createSqlHarness({
      papers: [pendingPromotion],
      richEvidenceCounts: {
        201: {
          sourceHash: evidenceSourceHash,
          sectionCount: 2,
          spanCount: 3,
          cardCount: 1,
          profileCount: 1,
        },
      },
      states: [
        state({
          feed_item_id: 201,
          source_hash: "processing-state-hash-that-does-not-match-evidence",
          deterministic_status: "succeeded",
          semantic_status: "succeeded",
          digest_ready: true,
        }),
      ],
    });

    const enqueued = await enqueueHotSetProcessingForFeedItems(
      harness.sql as never,
      [201],
      NOW,
    );

    expect(enqueued).toEqual({
      requestedFeedItemIds: [201],
      enqueuedFeedItemIds: [],
      enqueuedCount: 0,
      finalizedFeedItemIds: [201],
      finalizedCount: 1,
    });
    const evidenceCountQueries = harness.sql.mock.calls
      .map((call) => call[0].join(" "))
      .filter((text) =>
        text.includes("JOIN paper_sections ps") ||
        text.includes("JOIN paper_evidence_spans pes") ||
        text.includes("JOIN paper_evidence_cards pec") ||
        text.includes("JOIN paper_reader_profiles prp"),
      );
    expect(evidenceCountQueries.every((text) => !text.includes("pps.source_hash"))).toBe(true);
    expect(isPaperRichProcessingEligible(pendingPromotion)).toBe(true);
    expect(harness.paperFor(201)).toMatchObject({
      corpus_tier: "hot_set",
      hot_set_reason: "rich processing complete for pending Hot Set promotion",
      archive_reason: null,
      last_scored_at: NOW.toISOString(),
      tier_metadata_json: {
        lastReviewAction: "archive_to_hot_set",
        retention: {
          hotSetReadyAt: NOW.toISOString(),
          hotSetReadyReviewRunId: 77,
        },
      },
    });
    expect(harness.paperFor(201)?.tier_metadata_json?.retention?.pendingTier).toBeUndefined();
  });

  it("finalizes ready pending hot-set promotions without forcing a rebuild", async () => {
    const pendingPromotion = paper({
      id: 201,
      external_id: "2605.ready-pending",
      corpus_tier: "archive",
      archive_reason: "new selected paper pending hot-set readiness (14 day grace window)",
      tier_metadata_json: {
        retention: {
          pendingTier: "hot_set",
          pendingReviewAction: "archive_to_hot_set",
          pendingReviewRunId: 88,
        },
      },
    });
    const harness = createSqlHarness({
      papers: [pendingPromotion],
      richEvidenceCounts: {
        201: {
          sectionCount: 2,
          spanCount: 3,
          cardCount: 1,
          profileCount: 1,
        },
      },
      states: [
        state({
          feed_item_id: 201,
          deterministic_status: "succeeded",
          semantic_status: "succeeded",
          digest_ready: true,
        }),
      ],
    });

    const reconciled = await reconcilePendingHotSetPromotions(harness.sql as never, {
      now: NOW,
    });
    const claim = await claimNextDeterministicPaper(harness.sql as never, {
      now: NOW,
      leaseToken: "already-ready-token",
    });

    expect(reconciled).toMatchObject({
      enqueuedFeedItemIds: [],
      finalizedFeedItemIds: [201],
      finalizedCount: 1,
    });
    expect(claim).toBeNull();
    expect(harness.paperFor(201)).toMatchObject({
      corpus_tier: "hot_set",
      archive_reason: null,
      last_scored_at: NOW.toISOString(),
    });
    expect(harness.stateFor(201)).toMatchObject({
      deterministic_status: "succeeded",
      semantic_status: "succeeded",
      digest_ready: true,
      lease_token: null,
    });
  });

  it("does not finalize expired intake pending hot-set rows without a review promotion", async () => {
    const expiredIntakePending = paper({
      id: 201,
      external_id: "2605.expired-intake-pending",
      corpus_tier: "archive",
      archive_reason: "new selected paper pending hot-set readiness (14 day grace window)",
      tier_metadata_json: {
        retention: {
          intakeDefaultTier: "hot_set",
          selectedAt: "2026-05-01T00:00:00.000Z",
          graceDays: 14,
          pendingTier: "hot_set",
          pendingSourceTier: "archive",
          pendingReviewAction: "intake_to_hot_set",
          pendingReviewStartedAt: "2026-05-01T00:00:00.000Z",
        },
      },
    });
    const harness = createSqlHarness({
      papers: [expiredIntakePending],
      richEvidenceCounts: {
        201: {
          sectionCount: 2,
          spanCount: 3,
          cardCount: 1,
          profileCount: 1,
        },
      },
      states: [
        state({
          feed_item_id: 201,
          deterministic_status: "succeeded",
          semantic_status: "succeeded",
          digest_ready: true,
        }),
      ],
    });

    const reconciled = await reconcilePendingHotSetPromotions(harness.sql as never, {
      now: NOW,
    });

    expect(isPendingHotSetFinalizationAllowed(expiredIntakePending, NOW)).toBe(false);
    expect(isPaperRichProcessingEligible(expiredIntakePending, NOW)).toBe(false);
    expect(reconciled).toMatchObject({
      enqueuedFeedItemIds: [],
      finalizedFeedItemIds: [],
      finalizedCount: 0,
    });
    expect(harness.paperFor(201)).toMatchObject({
      corpus_tier: "archive",
      archive_reason: "new selected paper pending hot-set readiness (14 day grace window)",
      tier_metadata_json: {
        retention: {
          pendingTier: "hot_set",
          pendingReviewAction: "intake_to_hot_set",
        },
      },
    });
  });

  it("applies the intake grace boundary when authorizing finalization", () => {
    const intakePending = paper({
      corpus_tier: "archive",
      tier_metadata_json: {
        retention: {
          intakeDefaultTier: "hot_set",
          selectedAt: "2026-05-08T12:00:00.000Z",
          graceDays: 14,
          pendingTier: "hot_set",
          pendingSourceTier: "archive",
          pendingReviewAction: "intake_to_hot_set",
          pendingReviewStartedAt: "2026-05-08T12:00:00.000Z",
        },
      },
    });

    expect(
      isPendingHotSetFinalizationAllowed(
        intakePending,
        new Date("2026-05-22T12:00:00.000Z"),
      ),
    ).toBe(true);
    expect(
      isPendingHotSetFinalizationAllowed(
        intakePending,
        new Date("2026-05-22T12:00:00.001Z"),
      ),
    ).toBe(false);
  });

  it("does not finalize grace-preserved intake rows rewritten as review promotions after grace", async () => {
    const gracePreservedReviewPending = paper({
      id: 201,
      external_id: "2605.grace-preserved-review-pending",
      corpus_tier: "archive",
      archive_reason: "new selected paper pending hot-set readiness (14 day grace window)",
      tier_metadata_json: {
        retention: {
          intakeDefaultTier: "hot_set",
          selectedAt: "2026-05-01T00:00:00.000Z",
          graceDays: 14,
          pendingTier: "hot_set",
          pendingSourceTier: "archive",
          pendingReviewAction: "archive_to_hot_set",
          pendingReviewStartedAt: "2026-05-10T00:00:00.000Z",
          pendingReviewReasons: ["intake Hot Set grace window preserved"],
        },
      },
    });
    const harness = createSqlHarness({
      papers: [gracePreservedReviewPending],
      richEvidenceCounts: {
        201: {
          sectionCount: 2,
          spanCount: 3,
          cardCount: 1,
          profileCount: 1,
        },
      },
      states: [
        state({
          feed_item_id: 201,
          deterministic_status: "succeeded",
          semantic_status: "succeeded",
          digest_ready: true,
        }),
      ],
    });

    const reconciled = await reconcilePendingHotSetPromotions(harness.sql as never, {
      now: NOW,
    });

    expect(isPendingHotSetFinalizationAllowed(gracePreservedReviewPending, NOW)).toBe(false);
    expect(reconciled).toMatchObject({
      enqueuedFeedItemIds: [],
      finalizedFeedItemIds: [],
      finalizedCount: 0,
    });
    expect(harness.paperFor(201)).toMatchObject({
      corpus_tier: "archive",
      tier_metadata_json: {
        retention: {
          pendingTier: "hot_set",
          pendingReviewAction: "archive_to_hot_set",
          pendingReviewStartedAt: "2026-05-10T00:00:00.000Z",
        },
      },
    });
  });

  it("finalizes intake-origin pending hot-set rows from a post-grace review promotion", async () => {
    const postGraceReviewPending = paper({
      id: 201,
      external_id: "2605.post-grace-review-pending",
      corpus_tier: "archive",
      tier_metadata_json: {
        retention: {
          intakeDefaultTier: "hot_set",
          selectedAt: "2026-05-01T00:00:00.000Z",
          graceDays: 14,
          pendingTier: "hot_set",
          pendingSourceTier: "archive",
          pendingReviewRunId: 77,
          pendingReviewAction: "archive_to_hot_set",
          pendingReviewStartedAt: "2026-05-22T00:00:00.000Z",
        },
      },
    });
    const harness = createSqlHarness({
      papers: [postGraceReviewPending],
      richEvidenceCounts: {
        201: {
          sectionCount: 2,
          spanCount: 3,
          cardCount: 1,
          profileCount: 1,
        },
      },
      states: [
        state({
          feed_item_id: 201,
          deterministic_status: "succeeded",
          semantic_status: "succeeded",
          digest_ready: true,
        }),
      ],
    });

    const reconciled = await reconcilePendingHotSetPromotions(harness.sql as never, {
      now: NOW,
    });

    expect(isPendingHotSetFinalizationAllowed(postGraceReviewPending, NOW)).toBe(true);
    expect(reconciled).toMatchObject({
      enqueuedFeedItemIds: [],
      finalizedFeedItemIds: [201],
      finalizedCount: 1,
    });
    expect(harness.paperFor(201)).toMatchObject({
      corpus_tier: "hot_set",
      tier_metadata_json: {
        lastReviewAction: "archive_to_hot_set",
        retention: {
          intakeDefaultTier: "hot_set",
          hotSetReadyReviewRunId: 77,
        },
      },
    });
  });

  it("does not finalize pending hot-set promotions after manual blocking metadata", async () => {
    const manualArchive = paper({
      id: 201,
      external_id: "2605.manual-archive",
      corpus_tier: "archive",
      tier_metadata_json: {
        manualTier: "archive",
        retention: {
          pendingTier: "hot_set",
          pendingReviewAction: "archive_to_hot_set",
          pendingReviewRunId: 77,
        },
      },
    });
    const ignoredTier = paper({
      id: 202,
      external_id: "2605.ignored-tier",
      corpus_tier: "ignored",
      tier_metadata_json: {
        retention: {
          pendingTier: "hot_set",
          pendingReviewAction: "ignored_to_hot_set",
          pendingReviewRunId: 78,
        },
      },
    });
    const ignoredMetadata = paper({
      id: 203,
      external_id: "2605.ignored-metadata",
      corpus_tier: "archive",
      tier_metadata_json: {
        ignored: true,
        retention: {
          pendingTier: "hot_set",
          pendingReviewAction: "archive_to_hot_set",
          pendingReviewRunId: 79,
        },
      },
    });
    const harness = createSqlHarness({
      papers: [manualArchive, ignoredTier, ignoredMetadata],
      richEvidenceCounts: {
        201: { sectionCount: 2, spanCount: 3, cardCount: 1, profileCount: 1 },
        202: { sectionCount: 2, spanCount: 3, cardCount: 1, profileCount: 1 },
        203: { sectionCount: 2, spanCount: 3, cardCount: 1, profileCount: 1 },
      },
      states: [
        state({
          feed_item_id: 201,
          deterministic_status: "succeeded",
          semantic_status: "succeeded",
          digest_ready: true,
        }),
        state({
          feed_item_id: 202,
          deterministic_status: "succeeded",
          semantic_status: "succeeded",
          digest_ready: true,
        }),
        state({
          feed_item_id: 203,
          deterministic_status: "succeeded",
          semantic_status: "succeeded",
          digest_ready: true,
        }),
      ],
    });

    const enqueued = await enqueueHotSetProcessingForFeedItems(
      harness.sql as never,
      [201, 202, 203],
      NOW,
    );

    expect(enqueued).toEqual({
      requestedFeedItemIds: [201, 202, 203],
      enqueuedFeedItemIds: [],
      enqueuedCount: 0,
      finalizedFeedItemIds: [],
      finalizedCount: 0,
    });
    expect(harness.paperFor(201)).toMatchObject({
      corpus_tier: "archive",
      tier_metadata_json: {
        manualTier: "archive",
        retention: { pendingTier: "hot_set" },
      },
    });
    expect(harness.paperFor(202)).toMatchObject({
      corpus_tier: "ignored",
      tier_metadata_json: {
        retention: { pendingTier: "hot_set" },
      },
    });
    expect(harness.paperFor(203)).toMatchObject({
      corpus_tier: "archive",
      tier_metadata_json: {
        ignored: true,
        retention: { pendingTier: "hot_set" },
      },
    });
  });

  it("claims a specific deterministic paper for smoke runs", async () => {
    const newestPaper = paper({
      id: 102,
      external_id: "2605.54321",
      published_at: "2026-05-22T11:00:00.000Z",
    });
    const targetPaper = paper({
      id: 101,
      published_at: "2026-05-22T10:00:00.000Z",
    });
    const harness = createSqlHarness({
      papers: [targetPaper, newestPaper],
      states: [
        state({
          feed_item_id: 101,
          deterministic_status: "pending",
        }),
        state({
          feed_item_id: 102,
          deterministic_status: "pending",
        }),
      ],
    });

    const claim = await claimDeterministicPaperByFeedItemId(
      harness.sql as never,
      101,
      {
        now: NOW,
        leaseToken: "target-token",
      },
    );

    expect(claim?.paper.id).toBe(101);
    expect(claim?.leaseToken).toBe("target-token");
    expect(harness.stateFor(101)).toMatchObject({
      deterministic_status: "running",
      lease_token: "target-token",
    });
    expect(harness.stateFor(102)).toMatchObject({
      deterministic_status: "pending",
      lease_token: null,
    });
  });

  it("reclaims an expired running deterministic lease", async () => {
    const harness = createSqlHarness({
      papers: [paper()],
      states: [
        state({
          deterministic_status: "running",
          lease_token: "old-token",
          lease_expires_at: "2026-05-22T11:59:00.000Z",
        }),
      ],
    });

    const claim = await claimNextDeterministicPaper(harness.sql as never, {
      now: NOW,
      leaseToken: "new-token",
    });

    expect(claim?.paper.id).toBe(101);
    expect(claim?.leaseToken).toBe("new-token");
    expect(harness.stateFor(101)).toMatchObject({
      deterministic_status: "running",
      lease_token: "new-token",
    });
  });

  it("does not reclaim an unexpired deterministic lease", async () => {
    const harness = createSqlHarness({
      papers: [paper()],
      states: [
        state({
          deterministic_status: "failed",
          lease_token: "old-token",
          lease_expires_at: "2026-05-22T12:01:00.000Z",
        }),
      ],
    });

    const claim = await claimNextDeterministicPaper(harness.sql as never, {
      now: NOW,
      leaseToken: "new-token",
    });

    expect(claim).toBeNull();
    expect(harness.stateFor(101)?.lease_token).toBe("old-token");
  });

  it("advances deterministic retry backoff after failure", async () => {
    const harness = createSqlHarness({
      states: [
        state({
          deterministic_status: "running",
          deterministic_attempt_count: 0,
          lease_token: "lease-token",
        }),
      ],
    });

    const failure = await markDeterministicProcessingFailed(harness.sql as never, {
      feedItemId: 101,
      leaseToken: "lease-token",
      error: new Error("temporary build failure"),
      now: NOW,
    });

    expect(failure).toMatchObject({
      status: "failed",
      attemptCount: 1,
      dead: false,
    });
    expect(failure.nextRunAt?.toISOString()).toBe("2026-05-22T12:05:00.000Z");
    expect(calculateRetryNextRunAt(2, NOW)?.toISOString()).toBe(
      "2026-05-22T12:15:00.000Z",
    );
    expect(harness.stateFor(101)).toMatchObject({
      deterministic_status: "failed",
      deterministic_attempt_count: 1,
      deterministic_next_run_at: "2026-05-22T12:05:00.000Z",
      digest_ready: false,
    });
  });

  it("marks deterministic work dead at max attempts", async () => {
    const harness = createSqlHarness({
      states: [
        state({
          deterministic_status: "running",
          deterministic_attempt_count: 4,
          lease_token: "lease-token",
        }),
      ],
    });

    const failure = await markDeterministicProcessingFailed(harness.sql as never, {
      feedItemId: 101,
      leaseToken: "lease-token",
      error: new Error("still failing"),
      now: NOW,
    });

    expect(failure).toMatchObject({
      status: "dead",
      attemptCount: 5,
      dead: true,
      nextRunAt: null,
    });
    expect(harness.stateFor(101)).toMatchObject({
      deterministic_status: "dead",
      deterministic_attempt_count: 5,
      digest_ready: false,
    });
  });

  it("marks full-text unavailable as deterministic success pending semantic, not dead", async () => {
    const item = paper();
    const harness = createSqlHarness({
      states: [
        state({
          deterministic_status: "running",
          lease_token: "lease-token",
        }),
      ],
    });

    const updated = await markDeterministicProcessingSucceeded(
      harness.sql as never,
      {
        feedItemId: 101,
        leaseToken: "lease-token",
        sourceHash: computePaperProcessingSourceHash(item),
        evidenceQuality: "abstract_only",
        fullTextStatus: "unavailable",
        now: NOW,
      },
    );

    expect(updated).toMatchObject({
      deterministic_status: "succeeded",
      semantic_status: "pending",
      full_text_status: "unavailable",
      evidence_quality: "abstract_only",
      digest_ready: false,
    });
    expect(harness.stateFor(101)?.deterministic_status).not.toBe("dead");
  });

  it("rejects deterministic success when the source hash changed after claim", async () => {
    const item = paper();
    const harness = createSqlHarness({
      states: [
        state({
          source_hash: "newer-source-hash",
          deterministic_status: "running",
          lease_token: "lease-token",
        }),
      ],
    });

    await expect(
      markDeterministicProcessingSucceeded(harness.sql as never, {
        feedItemId: 101,
        leaseToken: "lease-token",
        sourceHash: computePaperProcessingSourceHash(item),
        expectedSourceHash: "claimed-source-hash",
        evidenceQuality: "abstract_only",
        fullTextStatus: "unavailable",
        now: NOW,
      }),
    ).rejects.toThrow(/No deterministic paper processing state updated/);

    expect(harness.stateFor(101)).toMatchObject({
      source_hash: "newer-source-hash",
      deterministic_status: "running",
      lease_token: "lease-token",
    });
  });

  it("claims deterministic-succeeded papers for semantic enrichment before digest readiness", async () => {
    const readyPaper = paper({
      id: 101,
      published_at: "2026-05-22T10:00:00.000Z",
      fetched_at: "2026-05-22T11:00:00.000Z",
    });
    const pendingPaper = paper({
      id: 102,
      external_id: "2605.54321",
      published_at: "2026-05-22T11:00:00.000Z",
      fetched_at: "2026-05-22T11:30:00.000Z",
    });
    const harness = createSqlHarness({
      papers: [readyPaper, pendingPaper],
      states: [
        state({
          feed_item_id: 101,
          deterministic_status: "succeeded",
          semantic_status: "pending",
          digest_ready: false,
        }),
        state({
          feed_item_id: 102,
          deterministic_status: "pending",
          semantic_status: "pending",
          digest_ready: false,
        }),
      ],
    });

    const claimed = await claimNextSemanticPaper(harness.sql as never, {
      now: NOW,
      leaseToken: "semantic-token",
    });

    expect(claimed?.paper.id).toBe(101);
    expect(harness.stateFor(101)).toMatchObject({
      semantic_status: "running",
      lease_token: "semantic-token",
      digest_ready: false,
    });
    expect(harness.stateFor(102)).toMatchObject({
      semantic_status: "pending",
      lease_token: null,
    });
  });

  it("claims untouched semantic papers before retrying failed papers", async () => {
    const failedPaper = paper({
      id: 102,
      external_id: "2605.failed",
      published_at: "2026-05-22T11:00:00.000Z",
      fetched_at: "2026-05-22T11:30:00.000Z",
    });
    const pendingPaper = paper({
      id: 101,
      external_id: "2605.pending",
      published_at: "2026-05-22T10:00:00.000Z",
      fetched_at: "2026-05-22T11:00:00.000Z",
    });
    const harness = createSqlHarness({
      papers: [pendingPaper, failedPaper],
      states: [
        state({
          feed_item_id: 101,
          deterministic_status: "succeeded",
          semantic_status: "pending",
          digest_ready: true,
        }),
        state({
          feed_item_id: 102,
          deterministic_status: "succeeded",
          semantic_status: "failed",
          semantic_attempt_count: 1,
          semantic_next_run_at: "2026-05-22T11:00:00.000Z",
          digest_ready: true,
        }),
      ],
    });

    const claimed = await claimNextSemanticPaper(harness.sql as never, {
      now: NOW,
      leaseToken: "semantic-token",
    });

    expect(claimed?.paper.id).toBe(101);
    expect(harness.stateFor(101)).toMatchObject({
      semantic_status: "running",
      lease_token: "semantic-token",
    });
    expect(harness.stateFor(102)).toMatchObject({
      semantic_status: "failed",
      lease_token: null,
    });
  });

  it("does not claim failed semantic papers at the max attempt cap", async () => {
    const harness = createSqlHarness({
      papers: [paper({ fetched_at: "2026-05-22T11:00:00.000Z" })],
      states: [
        state({
          deterministic_status: "succeeded",
          semantic_status: "failed",
          semantic_attempt_count: PAPER_SEMANTIC_MAX_ATTEMPTS,
          semantic_next_run_at: "2026-05-22T11:00:00.000Z",
          digest_ready: false,
        }),
      ],
    });

    const claimed = await claimNextSemanticPaper(harness.sql as never, {
      now: NOW,
      leaseToken: "semantic-token",
    });

    expect(claimed).toBeNull();
    expect(harness.stateFor(101)).toMatchObject({
      semantic_status: "failed",
      semantic_attempt_count: PAPER_SEMANTIC_MAX_ATTEMPTS,
      lease_token: null,
    });
  });

  it("does not claim semantic papers fetched more than 24 hours ago", async () => {
    const oldPaper = paper({
      id: 101,
      external_id: "2605.old",
      published_at: "2026-05-22T11:00:00.000Z",
      fetched_at: "2026-05-21T11:59:59.000Z",
    });
    const freshPaper = paper({
      id: 102,
      external_id: "2605.fresh",
      published_at: "2026-05-22T10:00:00.000Z",
      fetched_at: "2026-05-22T11:30:00.000Z",
    });
    const harness = createSqlHarness({
      papers: [oldPaper, freshPaper],
      states: [
        state({
          feed_item_id: 101,
          deterministic_status: "succeeded",
          semantic_status: "pending",
          digest_ready: true,
        }),
        state({
          feed_item_id: 102,
          deterministic_status: "succeeded",
          semantic_status: "pending",
          digest_ready: true,
        }),
      ],
    });

    const claimed = await claimNextSemanticPaper(harness.sql as never, {
      now: NOW,
      leaseToken: "semantic-token",
    });

    expect(claimed?.paper.id).toBe(102);
    expect(harness.stateFor(101)).toMatchObject({
      semantic_status: "pending",
      lease_token: null,
    });
    expect(harness.stateFor(102)).toMatchObject({
      semantic_status: "running",
      lease_token: "semantic-token",
    });
  });

  it("does not claim semantic papers included in recent digests", async () => {
    const recentlyDigestedPaper = paper({
      id: 101,
      external_id: "2605.digested",
      published_at: "2026-05-22T11:00:00.000Z",
      fetched_at: "2026-05-22T11:30:00.000Z",
    });
    const undigestedPaper = paper({
      id: 102,
      external_id: "2605.undigested",
      published_at: "2026-05-22T10:00:00.000Z",
      fetched_at: "2026-05-22T11:00:00.000Z",
    });
    const harness = createSqlHarness({
      latestDigestGeneratedAt: "2026-05-20T12:00:00.000Z",
      latestDigestSourceItemIds: [101],
      papers: [recentlyDigestedPaper, undigestedPaper],
      states: [
        state({
          feed_item_id: 101,
          deterministic_status: "succeeded",
          semantic_status: "pending",
          digest_ready: true,
        }),
        state({
          feed_item_id: 102,
          deterministic_status: "succeeded",
          semantic_status: "pending",
          digest_ready: true,
        }),
      ],
    });

    const claimed = await claimNextSemanticPaper(harness.sql as never, {
      now: NOW,
      leaseToken: "semantic-token",
    });

    expect(claimed?.paper.id).toBe(102);
    expect(harness.stateFor(101)).toMatchObject({
      semantic_status: "pending",
      lease_token: null,
    });
    expect(harness.stateFor(102)).toMatchObject({
      semantic_status: "running",
      lease_token: "semantic-token",
    });
  });

  it("places semantic retry ordering on the semantic claim query", () => {
    const source = readFileSync(
      join(process.cwd(), "lib/paper-processing-state.ts"),
      "utf8",
    );
    const deterministicClaim = source.slice(
      source.indexOf("export async function claimNextDeterministicPaper"),
      source.indexOf("export async function claimDeterministicPaperByFeedItemId"),
    );
    const semanticClaim = source.slice(
      source.indexOf("export async function claimNextSemanticPaper"),
      source.indexOf("export async function claimSemanticPaperByFeedItemId"),
    );

    expect(deterministicClaim).not.toContain("CASE pps.semantic_status");
    expect(semanticClaim).toContain("WITH recent_digest_papers AS");
    expect(semanticClaim).not.toContain("pps.digest_ready = TRUE");
    expect(semanticClaim).toContain("INTERVAL '24 hours'");
    expect(semanticClaim).toContain("INTERVAL '72 hours'");
    expect(semanticClaim).toContain("ANY(rdp.source_item_ids)");
    expect(semanticClaim).toContain(
      "COALESCE(pps.semantic_attempt_count, 0) < ${PAPER_SEMANTIC_MAX_ATTEMPTS}",
    );
    expect(semanticClaim).toContain("CASE pps.semantic_status");
    expect(semanticClaim).toContain("WHEN 'pending' THEN 0");
    expect(semanticClaim).toContain("WHEN 'stale' THEN 0");
    expect(semanticClaim).toContain("WHEN 'failed' THEN 2");
  });

  it("casts the hot-set readiness timestamp before building JSONB metadata", () => {
    const source = readFileSync(
      join(process.cwd(), "lib/paper-processing-state.ts"),
      "utf8",
    );
    const start = source.indexOf(
      "export async function finalizeCompletedPendingHotSetPromotions",
    );
    const end = source.indexOf(
      "async function rescheduleSemanticFinalizationFailure",
    );

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const finalizationSql = source.slice(start, end);
    expect(finalizationSql).toContain("'hotSetReadyAt'");
    expect(finalizationSql).toMatch(/'hotSetReadyAt',\s*\$\{nowIso\}::text/);
  });

  it("claims a specific semantic paper for smoke runs", async () => {
    const targetPaper = paper({
      id: 101,
      published_at: "2026-05-22T10:00:00.000Z",
    });
    const newerPaper = paper({
      id: 102,
      external_id: "2605.54321",
      published_at: "2026-05-22T11:00:00.000Z",
    });
    const harness = createSqlHarness({
      papers: [targetPaper, newerPaper],
      states: [
        state({
          feed_item_id: 101,
          deterministic_status: "succeeded",
          semantic_status: "pending",
          digest_ready: true,
        }),
        state({
          feed_item_id: 102,
          deterministic_status: "succeeded",
          semantic_status: "pending",
          digest_ready: true,
        }),
      ],
    });

    const claim = await claimSemanticPaperByFeedItemId(
      harness.sql as never,
      101,
      {
        now: NOW,
        leaseToken: "semantic-target-token",
      },
    );

    expect(claim?.paper.id).toBe(101);
    expect(claim?.leaseToken).toBe("semantic-target-token");
    expect(harness.stateFor(101)).toMatchObject({
      semantic_status: "running",
      lease_token: "semantic-target-token",
    });
    expect(harness.stateFor(102)).toMatchObject({
      semantic_status: "pending",
      lease_token: null,
    });
  });

  it("does not claim a specific semantic paper at the max attempt cap", async () => {
    const harness = createSqlHarness({
      papers: [paper({ fetched_at: "2026-05-22T11:00:00.000Z" })],
      states: [
        state({
          deterministic_status: "succeeded",
          semantic_status: "failed",
          semantic_attempt_count: PAPER_SEMANTIC_MAX_ATTEMPTS,
          semantic_next_run_at: "2026-05-22T11:00:00.000Z",
          digest_ready: false,
        }),
      ],
    });

    const claim = await claimSemanticPaperByFeedItemId(
      harness.sql as never,
      101,
      {
        now: NOW,
        leaseToken: "semantic-target-token",
      },
    );

    expect(claim).toBeNull();
    expect(harness.stateFor(101)).toMatchObject({
      semantic_status: "failed",
      semantic_attempt_count: PAPER_SEMANTIC_MAX_ATTEMPTS,
      lease_token: null,
    });
  });

  it("reclaims an expired running semantic lease", async () => {
    const harness = createSqlHarness({
      papers: [paper({ fetched_at: "2026-05-22T11:00:00.000Z" })],
      states: [
        state({
          deterministic_status: "succeeded",
          semantic_status: "running",
          digest_ready: true,
          lease_token: "old-token",
          lease_expires_at: "2026-05-22T11:59:00.000Z",
        }),
      ],
    });

    const claimed = await claimNextSemanticPaper(harness.sql as never, {
      now: NOW,
      leaseToken: "new-semantic-token",
    });

    expect(claimed?.paper.id).toBe(101);
    expect(claimed?.leaseToken).toBe("new-semantic-token");
    expect(harness.stateFor(101)).toMatchObject({
      semantic_status: "running",
      lease_token: "new-semantic-token",
      digest_ready: false,
    });
  });

  it("does not reclaim an unexpired semantic lease", async () => {
    const harness = createSqlHarness({
      papers: [paper({ fetched_at: "2026-05-22T11:00:00.000Z" })],
      states: [
        state({
          deterministic_status: "succeeded",
          semantic_status: "failed",
          digest_ready: true,
          lease_token: "old-token",
          lease_expires_at: "2026-05-22T12:01:00.000Z",
        }),
      ],
    });

    const claimed = await claimNextSemanticPaper(harness.sql as never, {
      now: NOW,
      leaseToken: "new-semantic-token",
    });

    expect(claimed).toBeNull();
    expect(harness.stateFor(101)?.lease_token).toBe("old-token");
  });

  it("marks semantic success as digest ready", async () => {
    const harness = createSqlHarness({
      states: [
        state({
          deterministic_status: "succeeded",
          semantic_status: "running",
          digest_ready: false,
          semantic_attempt_count: 2,
          lease_token: "semantic-token",
        }),
      ],
    });

    const updated = await markSemanticProcessingSucceeded(harness.sql as never, {
      feedItemId: 101,
      leaseToken: "semantic-token",
      now: NOW,
    });

    expect(updated).toMatchObject({
      semantic_status: "succeeded",
      semantic_attempt_count: 0,
      digest_ready: true,
    });
    expect(harness.stateFor(101)).toMatchObject({
      semantic_status: "succeeded",
      digest_ready: true,
      lease_token: null,
    });
  });

  it("finalizes pending hot-set promotion when semantic processing succeeds with complete evidence", async () => {
    const pendingPromotion = paper({
      corpus_tier: "archive",
      tier_metadata_json: {
        lastReviewAction: "archive_to_pending_hot_set",
        retention: {
          pendingTier: "hot_set",
          pendingReviewAction: "archive_to_hot_set",
          pendingReviewRunId: 88,
        },
      },
    });
    const harness = createSqlHarness({
      papers: [pendingPromotion],
      richEvidenceCounts: {
        101: {
          sectionCount: 2,
          spanCount: 3,
          cardCount: 1,
          profileCount: 1,
        },
      },
      states: [
        state({
          deterministic_status: "succeeded",
          semantic_status: "running",
          digest_ready: true,
          semantic_attempt_count: 2,
          lease_token: "semantic-token",
        }),
      ],
    });

    const updated = await markSemanticProcessingSucceeded(harness.sql as never, {
      feedItemId: 101,
      leaseToken: "semantic-token",
      now: NOW,
    });

    expect(updated).toMatchObject({
      semantic_status: "succeeded",
      semantic_attempt_count: 0,
      digest_ready: true,
    });
    expect(harness.paperFor(101)).toMatchObject({
      corpus_tier: "hot_set",
      tier_metadata_json: {
        lastReviewAction: "archive_to_hot_set",
        retention: {
          hotSetReadyAt: NOW.toISOString(),
          hotSetReadyReviewRunId: 88,
        },
      },
    });
  });

  it("backs off pending hot-set finalization when finalization fails after semantic success", async () => {
    const pendingPromotion = paper({
      corpus_tier: "archive",
      fetched_at: NOW.toISOString(),
      tier_metadata_json: {
        lastReviewAction: "archive_to_pending_hot_set",
        retention: {
          pendingTier: "hot_set",
          pendingReviewAction: "archive_to_hot_set",
          pendingReviewRunId: 89,
        },
      },
    });
    const harness = createSqlHarness({
      papers: [pendingPromotion],
      finalizeThrows: true,
      richEvidenceCounts: {
        101: {
          sectionCount: 2,
          spanCount: 3,
          cardCount: 1,
          profileCount: 1,
        },
      },
      states: [
        state({
          deterministic_status: "succeeded",
          semantic_status: "running",
          digest_ready: true,
          semantic_attempt_count: 1,
          lease_token: "semantic-token",
        }),
      ],
    });

    const updated = await markSemanticProcessingSucceeded(harness.sql as never, {
      feedItemId: 101,
      leaseToken: "semantic-token",
      now: NOW,
    });
    const immediateRetryClaim = await claimNextSemanticPaper(harness.sql as never, {
      now: NOW,
      leaseToken: "retry-semantic-token",
    });
    const retryAt = calculateRetryNextRunAt(2, NOW);
    const laterRetryClaim = await claimNextSemanticPaper(harness.sql as never, {
      now: retryAt ?? NOW,
      leaseToken: "retry-semantic-token",
    });

    expect(updated).toMatchObject({
      semantic_status: "failed",
      semantic_attempt_count: 2,
      digest_ready: false,
      semantic_next_run_at: "2026-05-22T12:15:00.000Z",
      semantic_last_error: "finalize failed",
      lease_token: null,
    });
    expect(harness.paperFor(101)).toMatchObject({
      corpus_tier: "archive",
      tier_metadata_json: {
        retention: {
          pendingTier: "hot_set",
          pendingReviewRunId: 89,
        },
      },
    });
    expect(immediateRetryClaim).toBeNull();
    expect(laterRetryClaim?.paper.id).toBe(101);
    expect(harness.stateFor(101)).toMatchObject({
      semantic_status: "running",
      lease_token: "retry-semantic-token",
    });
  });

  it("dead-letters pending hot-set finalization after repeated semantic finalization failures", async () => {
    const pendingPromotion = paper({
      corpus_tier: "archive",
      fetched_at: NOW.toISOString(),
      tier_metadata_json: {
        lastReviewAction: "archive_to_pending_hot_set",
        retention: {
          pendingTier: "hot_set",
          pendingReviewAction: "archive_to_hot_set",
          pendingReviewRunId: 90,
        },
      },
    });
    const harness = createSqlHarness({
      papers: [pendingPromotion],
      finalizeThrows: true,
      richEvidenceCounts: {
        101: {
          sectionCount: 2,
          spanCount: 3,
          cardCount: 1,
          profileCount: 1,
        },
      },
      states: [
        state({
          deterministic_status: "succeeded",
          semantic_status: "running",
          digest_ready: true,
          semantic_attempt_count: 2,
          lease_token: "semantic-token",
        }),
      ],
    });

    const updated = await markSemanticProcessingSucceeded(harness.sql as never, {
      feedItemId: 101,
      leaseToken: "semantic-token",
      now: NOW,
    });
    const retryClaim = await claimNextSemanticPaper(harness.sql as never, {
      now: NOW,
      leaseToken: "retry-semantic-token",
    });

    expect(updated).toMatchObject({
      semantic_status: "dead",
      semantic_attempt_count: 3,
      digest_ready: false,
      semantic_next_run_at: NOW.toISOString(),
      semantic_last_error: "finalize failed",
      lease_token: null,
    });
    expect(retryClaim).toBeNull();
    expect(harness.stateFor(101)).toMatchObject({
      semantic_status: "dead",
      semantic_attempt_count: 3,
      digest_ready: false,
      lease_token: null,
    });
  });

  it("rejects semantic success when the source hash changed after claim", async () => {
    const harness = createSqlHarness({
      states: [
        state({
          source_hash: "newer-source-hash",
          deterministic_status: "succeeded",
          semantic_status: "running",
          digest_ready: true,
          semantic_attempt_count: 2,
          lease_token: "semantic-token",
        }),
      ],
    });

    await expect(
      markSemanticProcessingSucceeded(harness.sql as never, {
        feedItemId: 101,
        leaseToken: "semantic-token",
        expectedSourceHash: "claimed-source-hash",
        now: NOW,
      }),
    ).rejects.toThrow(/No semantic paper processing state updated/);

    expect(harness.stateFor(101)).toMatchObject({
      source_hash: "newer-source-hash",
      semantic_status: "running",
      lease_token: "semantic-token",
    });
  });

  it("schedules semantic retry and keeps digest not ready", async () => {
    const harness = createSqlHarness({
      states: [
        state({
          deterministic_status: "succeeded",
          semantic_status: "running",
          digest_ready: false,
          semantic_attempt_count: 0,
          lease_token: "semantic-token",
        }),
      ],
    });

    const failure = await markSemanticProcessingFailed(harness.sql as never, {
      feedItemId: 101,
      leaseToken: "semantic-token",
      error: new Error("temporary LLM failure"),
      now: NOW,
    });

    expect(failure).toMatchObject({
      status: "failed",
      attemptCount: 1,
      dead: false,
    });
    expect(failure.nextRunAt?.toISOString()).toBe("2026-05-22T12:05:00.000Z");
    expect(harness.stateFor(101)).toMatchObject({
      semantic_status: "failed",
      semantic_attempt_count: 1,
      semantic_next_run_at: "2026-05-22T12:05:00.000Z",
      digest_ready: false,
      lease_token: null,
    });
  });

  it("marks repeated semantic failure dead and keeps digest not ready", async () => {
    const harness = createSqlHarness({
      states: [
        state({
          deterministic_status: "succeeded",
          semantic_status: "running",
          digest_ready: false,
          semantic_attempt_count: 2,
          lease_token: "semantic-token",
        }),
      ],
    });

    const failure = await markSemanticProcessingFailed(harness.sql as never, {
      feedItemId: 101,
      leaseToken: "semantic-token",
      error: new Error("still failing"),
      now: NOW,
    });

    expect(failure).toMatchObject({
      status: "dead",
      attemptCount: 3,
      dead: true,
      nextRunAt: null,
    });
    expect(harness.stateFor(101)).toMatchObject({
      semantic_status: "dead",
      semantic_attempt_count: 3,
      digest_ready: false,
      lease_token: null,
    });
  });

  it("migration backfills only rich-processing-eligible papers into the deterministic queue", () => {
    const migration = readFileSync(
      join(process.cwd(), "db/migrations/005_paper_processing_state.sql"),
      "utf8",
    );

    expect(migration).toContain("INSERT INTO paper_processing_state");
    expect(migration).toContain("FROM feed_items fi");
    expect(migration).toContain("WHERE fi.source_type = 'paper'");
    expect(migration).toContain("COALESCE(fi.corpus_tier, 'archive') = 'hot_set'");
    expect(migration).toContain("COALESCE(fi.tier_metadata_json->>'pinned', 'false') = 'true'");
    expect(migration).toContain("COALESCE(fi.tier_metadata_json->>'manualTier', '') = 'hot_set'");
    expect(migration).toContain("COALESCE(fi.tier_metadata_json->'retention'->>'pendingTier', '') = 'hot_set'");
    expect(migration).toContain("intakeDefaultTier");
    expect(migration).toContain("graceDays");
    expect(migration).toContain("COALESCE(fi.tier_metadata_json->>'manualTier', '') NOT IN ('archive', 'core_canon', 'ignored')");
    expect(migration).toContain("ON CONFLICT (feed_item_id) DO NOTHING");
    expect(migration).toContain("WHEN NULLIF(BTRIM(fi.full_text), '') IS NOT NULL THEN 'succeeded'");
  });
});
