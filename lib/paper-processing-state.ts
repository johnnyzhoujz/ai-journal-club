import { createHash, randomUUID } from "node:crypto";

import { sql as defaultSql } from "@/lib/db";
import {
  computePaperEvidenceLayerSourceHash,
  PAPER_EVIDENCE_LAYER_EXTRACTOR_VERSION,
  PAPER_EVIDENCE_LAYER_PARSER_VERSION,
} from "@/lib/paper-evidence-layer";
import type {
  CorpusTier,
  FeedItemSourceType,
  PaperCorpusTierMetadata,
  PaperMeta,
} from "@/lib/schema";

type SqlClient = typeof defaultSql;

export type PaperEvidenceQuality =
  | "unknown"
  | "full_text"
  | "truncated_full_text"
  | "abstract_only"
  | "metadata_only";

export type PaperFullTextProcessingStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "unavailable"
  | "failed"
  | "dead"
  | "stale";

export type PaperDeterministicProcessingStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "dead"
  | "stale";

export type PaperSemanticProcessingStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "dead"
  | "stale"
  | "skipped";

export interface PaperProcessingState {
  feed_item_id: number;
  source_hash: string | null;
  evidence_quality: PaperEvidenceQuality;
  full_text_status: PaperFullTextProcessingStatus;
  deterministic_status: PaperDeterministicProcessingStatus;
  semantic_status: PaperSemanticProcessingStatus;
  digest_ready: boolean;
  deterministic_attempt_count: number;
  semantic_attempt_count: number;
  deterministic_next_run_at: string | Date;
  semantic_next_run_at: string | Date;
  lease_token: string | null;
  lease_expires_at: string | Date | null;
  deterministic_last_error: string | null;
  semantic_last_error: string | null;
  last_started_at: string | Date | null;
  last_success_at: string | Date | null;
  last_failed_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface PaperProcessingStateFeedItem {
  id: number;
  source_type: FeedItemSourceType;
  external_id?: string | null;
  title: string | null;
  content: string;
  url?: string | null;
  author_name: string;
  author_handle: string | null;
  published_at: string | Date | null;
  fetched_at?: string | Date | null;
  corpus_tier?: CorpusTier | null;
  paper_meta: PaperMeta | null;
  tier_metadata_json?: PaperCorpusTierMetadata | null;
  full_text?: string | null;
  full_text_source?: "arxiv_html" | "hf_page" | null;
}

export interface ClaimedDeterministicPaper {
  leaseToken: string;
  state: PaperProcessingState;
  paper: PaperProcessingStateFeedItem & {
    external_id: string;
    url: string;
    full_text: string | null;
    full_text_source: "arxiv_html" | "hf_page" | null;
  };
}

export interface ClaimedSemanticPaper {
  leaseToken: string;
  state: PaperProcessingState;
  paper: PaperProcessingStateFeedItem & {
    external_id: string;
    url: string;
    full_text: string | null;
    full_text_source: "arxiv_html" | "hf_page" | null;
  };
}

export type EnsurePaperProcessingStateAction =
  | "created"
  | "unchanged"
  | "stale"
  | "skipped";

export interface EnsurePaperProcessingStateResult {
  action: EnsurePaperProcessingStateAction;
  sourceHash: string | null;
  state: PaperProcessingState | null;
}

export interface DeterministicFailureResult {
  feedItemId: number;
  status: PaperDeterministicProcessingStatus;
  attemptCount: number;
  nextRunAt: Date | null;
  dead: boolean;
}

export interface SemanticFailureResult {
  feedItemId: number;
  status: PaperSemanticProcessingStatus;
  attemptCount: number;
  nextRunAt: Date | null;
  dead: boolean;
}

export interface HotSetProcessingEnqueueResult {
  requestedFeedItemIds: number[];
  enqueuedFeedItemIds: number[];
  enqueuedCount: number;
  finalizedFeedItemIds: number[];
  finalizedCount: number;
}

export const PAPER_PROCESSING_SOURCE_HASH_VERSION =
  "paper-processing-source:v1";
export const PAPER_DETERMINISTIC_MAX_ATTEMPTS = 5;
export const PAPER_SEMANTIC_MAX_ATTEMPTS = 3;
export const PAPER_DETERMINISTIC_LEASE_MS = 5 * 60 * 1000;
export const PAPER_SEMANTIC_LEASE_MS = 5 * 60 * 1000;

const RETRY_BACKOFF_MS = [
  5 * 60 * 1000,
  15 * 60 * 1000,
  60 * 60 * 1000,
  6 * 60 * 60 * 1000,
];

const OPTIONAL_RICH_EVIDENCE_TABLES = [
  "paper_sections",
  "paper_evidence_spans",
  "paper_evidence_cards",
  "paper_reader_profiles",
] as const;

type OptionalRichEvidenceTable = (typeof OPTIONAL_RICH_EVIDENCE_TABLES)[number];

type OptionalRichEvidenceTableAvailability = Record<
  OptionalRichEvidenceTable,
  boolean
>;

type EvidenceCountRow = {
  feed_item_id: number | string;
  row_count: number | string | null;
};

type EvidenceSourceHashRow = {
  feed_item_id: number | string;
  title: string | null;
  content: string | null;
  full_text: string | null;
};

type EvidenceSourceHashEntry = {
  feedItemId: number;
  sourceHash: string;
};

type RichEvidenceCounts = {
  feedItemId: number;
  sectionCount: number;
  spanCount: number;
  cardCount: number;
  profileCount: number;
};

function toInteger(value: unknown): number {
  if (typeof value === "number") {
    return Math.trunc(value);
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function stableStringify(value: unknown): string {
  if (value == null) {
    return "";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeDateForHash(value: string | Date | null | undefined): string {
  if (!value) {
    return "";
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

function toStateRow(row: PaperProcessingState): PaperProcessingState {
  return {
    ...row,
    feed_item_id: toInteger(row.feed_item_id),
    deterministic_attempt_count: toInteger(row.deterministic_attempt_count),
    semantic_attempt_count: toInteger(row.semantic_attempt_count),
    digest_ready: Boolean(row.digest_ready),
  };
}

function initialFullTextStatus(
  item: Pick<PaperProcessingStateFeedItem, "full_text">,
): PaperFullTextProcessingStatus {
  return item.full_text?.trim() ? "succeeded" : "pending";
}

function changedFullTextStatus(
  item: Pick<PaperProcessingStateFeedItem, "full_text">,
): PaperFullTextProcessingStatus {
  return item.full_text?.trim() ? "succeeded" : "stale";
}

function truncateError(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return message.slice(0, 2_000);
}

function metadataString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function hasFinalizablePendingHotSetPromotionMetadata(
  metadata: PaperCorpusTierMetadata | null | undefined,
  now: Date,
): boolean {
  return isPendingHotSetFinalizationAllowed({ tier_metadata_json: metadata }, now);
}

function metadataNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function metadataDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function intakeHotSetGraceWindow(retention: NonNullable<PaperCorpusTierMetadata["retention"]>) {
  const selectedAt =
    metadataDate(retention.selectedAt) ??
    metadataDate(retention.pendingReviewStartedAt);
  if (!selectedAt) {
    return null;
  }

  const graceDays = metadataNumber(retention.graceDays) ?? 14;
  const graceExpiresAt = new Date(selectedAt.getTime() + graceDays * 86_400_000);
  const pendingReviewStartedAt =
    metadataDate(retention.pendingReviewStartedAt) ?? selectedAt;

  return {
    selectedAt,
    graceExpiresAt,
    pendingReviewStartedAt,
  };
}

export function isPendingHotSetFinalizationAllowed(
  item: Pick<PaperProcessingStateFeedItem, "tier_metadata_json">,
  now: Date = new Date(),
): boolean {
  const retention = item.tier_metadata_json?.retention;
  if (retention?.pendingTier !== "hot_set") {
    return false;
  }
  if (retention.intakeDefaultTier !== "hot_set") {
    return true;
  }

  const graceWindow = intakeHotSetGraceWindow(retention);
  if (!graceWindow) {
    return false;
  }

  if (graceWindow.pendingReviewStartedAt.getTime() > graceWindow.graceExpiresAt.getTime()) {
    return true;
  }

  return now.getTime() >= graceWindow.selectedAt.getTime() &&
    now.getTime() <= graceWindow.graceExpiresAt.getTime();
}

function isOptionalRichEvidenceTable(
  value: string,
): value is OptionalRichEvidenceTable {
  return (OPTIONAL_RICH_EVIDENCE_TABLES as readonly string[]).includes(value);
}

function emptyRichEvidenceTableAvailability(): OptionalRichEvidenceTableAvailability {
  return {
    paper_sections: false,
    paper_evidence_spans: false,
    paper_evidence_cards: false,
    paper_reader_profiles: false,
  };
}

function rowsToCountMap(rows: EvidenceCountRow[]): Map<number, number> {
  return new Map(
    rows.map((row) => [
      toInteger(row.feed_item_id),
      toInteger(row.row_count),
    ]),
  );
}

async function loadPaperEvidenceSourceHashEntries(
  sqlClient: SqlClient,
  feedItemIds: number[],
): Promise<EvidenceSourceHashEntry[]> {
  if (feedItemIds.length === 0) {
    return [];
  }

  const rows = (await sqlClient`
    SELECT
      fi.id AS feed_item_id,
      fi.title,
      fi.content,
      fi.full_text
    FROM feed_items fi
    WHERE fi.source_type = 'paper'
      AND fi.id = ANY(${feedItemIds}::int[])
  `) as EvidenceSourceHashRow[];

  return rows.map((row) => {
    const feedItemId = toInteger(row.feed_item_id);
    return {
      feedItemId,
      sourceHash: computePaperEvidenceLayerSourceHash({
        id: feedItemId,
        title: row.title,
        content: row.content ?? "",
        full_text: row.full_text,
      }),
    };
  });
}

async function loadOptionalRichEvidenceTableAvailability(
  sqlClient: SqlClient,
): Promise<OptionalRichEvidenceTableAvailability> {
  const rows = (await sqlClient`
    SELECT
      table_name,
      to_regclass('public.' || table_name) IS NOT NULL AS exists
    FROM unnest(${[...OPTIONAL_RICH_EVIDENCE_TABLES]}::text[]) AS table_names(table_name)
  `) as Array<{ table_name: string; exists: boolean }>;

  const availability = emptyRichEvidenceTableAvailability();
  for (const row of rows) {
    if (isOptionalRichEvidenceTable(row.table_name)) {
      availability[row.table_name] = row.exists === true;
    }
  }
  return availability;
}

async function loadPaperSectionCounts(
  sqlClient: SqlClient,
  sourceHashEntries: EvidenceSourceHashEntry[],
): Promise<Map<number, number>> {
  if (sourceHashEntries.length === 0) {
    return new Map();
  }

  const rows = (await sqlClient`
    WITH expected AS (
      SELECT *
      FROM unnest(
        ${sourceHashEntries.map((entry) => entry.feedItemId)}::int[],
        ${sourceHashEntries.map((entry) => entry.sourceHash)}::text[]
      ) AS expected(feed_item_id, source_hash)
    )
    SELECT
      expected.feed_item_id AS feed_item_id,
      COUNT(*) AS row_count
    FROM expected
    JOIN paper_sections ps
      ON ps.feed_item_id = expected.feed_item_id
      AND ps.source_hash = expected.source_hash
    GROUP BY expected.feed_item_id
  `) as EvidenceCountRow[];

  return rowsToCountMap(rows);
}

async function loadPaperEvidenceSpanCounts(
  sqlClient: SqlClient,
  sourceHashEntries: EvidenceSourceHashEntry[],
): Promise<Map<number, number>> {
  if (sourceHashEntries.length === 0) {
    return new Map();
  }

  const rows = (await sqlClient`
    WITH expected AS (
      SELECT *
      FROM unnest(
        ${sourceHashEntries.map((entry) => entry.feedItemId)}::int[],
        ${sourceHashEntries.map((entry) => entry.sourceHash)}::text[]
      ) AS expected(feed_item_id, source_hash)
    )
    SELECT
      expected.feed_item_id AS feed_item_id,
      COUNT(*) AS row_count
    FROM expected
    JOIN paper_evidence_spans pes
      ON pes.feed_item_id = expected.feed_item_id
      AND pes.source_hash = expected.source_hash
    GROUP BY expected.feed_item_id
  `) as EvidenceCountRow[];

  return rowsToCountMap(rows);
}

async function loadPaperEvidenceCardCounts(
  sqlClient: SqlClient,
  sourceHashEntries: EvidenceSourceHashEntry[],
): Promise<Map<number, number>> {
  if (sourceHashEntries.length === 0) {
    return new Map();
  }

  const rows = (await sqlClient`
    WITH expected AS (
      SELECT *
      FROM unnest(
        ${sourceHashEntries.map((entry) => entry.feedItemId)}::int[],
        ${sourceHashEntries.map((entry) => entry.sourceHash)}::text[]
      ) AS expected(feed_item_id, source_hash)
    )
    SELECT
      expected.feed_item_id AS feed_item_id,
      COUNT(*) AS row_count
    FROM expected
    JOIN paper_evidence_cards pec
      ON pec.feed_item_id = expected.feed_item_id
      AND pec.source_hash = expected.source_hash
    GROUP BY expected.feed_item_id
  `) as EvidenceCountRow[];

  return rowsToCountMap(rows);
}

async function loadPaperReaderProfileCounts(
  sqlClient: SqlClient,
  sourceHashEntries: EvidenceSourceHashEntry[],
): Promise<Map<number, number>> {
  if (sourceHashEntries.length === 0) {
    return new Map();
  }

  const rows = (await sqlClient`
    WITH expected AS (
      SELECT *
      FROM unnest(
        ${sourceHashEntries.map((entry) => entry.feedItemId)}::int[],
        ${sourceHashEntries.map((entry) => entry.sourceHash)}::text[]
      ) AS expected(feed_item_id, source_hash)
    )
    SELECT
      expected.feed_item_id AS feed_item_id,
      COUNT(*) AS row_count
    FROM expected
    JOIN paper_reader_profiles prp
      ON prp.feed_item_id = expected.feed_item_id
      AND prp.source_hash = expected.source_hash
    GROUP BY expected.feed_item_id
  `) as EvidenceCountRow[];

  return rowsToCountMap(rows);
}

async function loadRichEvidenceCounts(
  sqlClient: SqlClient,
  feedItemIds: number[],
): Promise<RichEvidenceCounts[]> {
  const [availability, sourceHashEntries] = await Promise.all([
    loadOptionalRichEvidenceTableAvailability(sqlClient),
    loadPaperEvidenceSourceHashEntries(sqlClient, feedItemIds),
  ]);
  const [
    sectionCounts,
    spanCounts,
    cardCounts,
    profileCounts,
  ] = await Promise.all([
    availability.paper_sections
      ? loadPaperSectionCounts(sqlClient, sourceHashEntries)
      : new Map<number, number>(),
    availability.paper_evidence_spans
      ? loadPaperEvidenceSpanCounts(sqlClient, sourceHashEntries)
      : new Map<number, number>(),
    availability.paper_evidence_cards
      ? loadPaperEvidenceCardCounts(sqlClient, sourceHashEntries)
      : new Map<number, number>(),
    availability.paper_reader_profiles
      ? loadPaperReaderProfileCounts(sqlClient, sourceHashEntries)
      : new Map<number, number>(),
  ]);

  return feedItemIds.map((feedItemId) => ({
    feedItemId,
    sectionCount: sectionCounts.get(feedItemId) ?? 0,
    spanCount: spanCounts.get(feedItemId) ?? 0,
    cardCount: cardCounts.get(feedItemId) ?? 0,
    profileCount: profileCounts.get(feedItemId) ?? 0,
  }));
}

export function isPaperRichProcessingEligible(
  item: Pick<
    PaperProcessingStateFeedItem,
    "source_type" | "corpus_tier" | "tier_metadata_json"
  >,
  now: Date = new Date(),
): boolean {
  if (item.source_type !== "paper") {
    return false;
  }

  const metadata = item.tier_metadata_json ?? null;
  const manualTier = metadataString(metadata?.manualTier);
  if (
    item.corpus_tier === "ignored" ||
    metadata?.ignored ||
    manualTier === "archive" ||
    manualTier === "ignored" ||
    manualTier === "core_canon"
  ) {
    return false;
  }

  return (
    item.corpus_tier === "hot_set" ||
    metadata?.pinned === true ||
    manualTier === "hot_set" ||
    hasFinalizablePendingHotSetPromotionMetadata(metadata, now)
  );
}

export function computePaperProcessingSourceHash(
  item: PaperProcessingStateFeedItem,
): string {
  return createHash("sha256")
    .update(
      [
        PAPER_PROCESSING_SOURCE_HASH_VERSION,
        PAPER_EVIDENCE_LAYER_PARSER_VERSION,
        PAPER_EVIDENCE_LAYER_EXTRACTOR_VERSION,
        item.source_type,
        item.external_id ?? "",
        item.title ?? "",
        item.content ?? "",
        item.url ?? "",
        item.author_name ?? "",
        item.author_handle ?? "",
        normalizeDateForHash(item.published_at),
        stableStringify(item.paper_meta),
        item.full_text_source ?? "",
        item.full_text ?? "",
      ].join("\n"),
    )
    .digest("hex");
}

export function calculateRetryBackoffMs(attemptCount: number): number | null {
  if (attemptCount >= PAPER_DETERMINISTIC_MAX_ATTEMPTS) {
    return null;
  }
  return RETRY_BACKOFF_MS[Math.max(0, attemptCount - 1)] ?? RETRY_BACKOFF_MS.at(-1)!;
}

export function calculateRetryNextRunAt(
  attemptCount: number,
  now: Date = new Date(),
): Date | null {
  const backoffMs = calculateRetryBackoffMs(attemptCount);
  return backoffMs == null ? null : new Date(now.getTime() + backoffMs);
}

export async function ensurePaperProcessingStateForFeedItem(
  sqlClient: SqlClient,
  item: PaperProcessingStateFeedItem,
  now: Date = new Date(),
): Promise<EnsurePaperProcessingStateResult> {
  if (item.source_type !== "paper") {
    return { action: "skipped", sourceHash: null, state: null };
  }

  const sourceHash = computePaperProcessingSourceHash(item);
  const nowIso = now.toISOString();
  const existingRows = (await sqlClient`
    SELECT *
    FROM paper_processing_state
    WHERE feed_item_id = ${item.id}
    LIMIT 1
  `) as PaperProcessingState[];
  const existing = existingRows[0] ? toStateRow(existingRows[0]) : null;

  if (!existing) {
    const insertedRows = (await sqlClient`
      INSERT INTO paper_processing_state (
        feed_item_id,
        source_hash,
        full_text_status,
        deterministic_status,
        semantic_status,
        digest_ready,
        deterministic_next_run_at,
        semantic_next_run_at
      )
      VALUES (
        ${item.id},
        ${sourceHash},
        ${initialFullTextStatus(item)},
        'pending',
        'pending',
        FALSE,
        ${nowIso}::timestamptz,
        ${nowIso}::timestamptz
      )
      ON CONFLICT (feed_item_id) DO NOTHING
      RETURNING *
    `) as PaperProcessingState[];
    const inserted = insertedRows[0] ? toStateRow(insertedRows[0]) : null;
    if (inserted) {
      return { action: "created", sourceHash, state: inserted };
    }

    const racedRows = (await sqlClient`
      SELECT *
      FROM paper_processing_state
      WHERE feed_item_id = ${item.id}
      LIMIT 1
    `) as PaperProcessingState[];
    const raced = racedRows[0] ? toStateRow(racedRows[0]) : null;
    return {
      action: raced?.source_hash === sourceHash ? "unchanged" : "stale",
      sourceHash,
      state: raced,
    };
  }

  if (existing.source_hash === sourceHash) {
    return { action: "unchanged", sourceHash, state: existing };
  }

  const updatedRows = (await sqlClient`
    UPDATE paper_processing_state
    SET source_hash = ${sourceHash},
        evidence_quality = 'unknown',
        full_text_status = ${changedFullTextStatus(item)},
        deterministic_status = 'stale',
        semantic_status = CASE
          WHEN semantic_status = 'skipped' THEN 'skipped'
          ELSE 'stale'
        END,
        digest_ready = FALSE,
        deterministic_attempt_count = 0,
        semantic_attempt_count = 0,
        deterministic_next_run_at = ${nowIso}::timestamptz,
        semantic_next_run_at = ${nowIso}::timestamptz,
        lease_token = CASE
          WHEN lease_token IS NOT NULL
            AND lease_expires_at > ${nowIso}::timestamptz
          THEN lease_token
          ELSE NULL
        END,
        lease_expires_at = CASE
          WHEN lease_token IS NOT NULL
            AND lease_expires_at > ${nowIso}::timestamptz
          THEN lease_expires_at
          ELSE NULL
        END,
        deterministic_last_error = NULL,
        semantic_last_error = NULL,
        updated_at = ${nowIso}::timestamptz
    WHERE feed_item_id = ${item.id}
    RETURNING *
  `) as PaperProcessingState[];

  return {
    action: "stale",
    sourceHash,
    state: updatedRows[0] ? toStateRow(updatedRows[0]) : existing,
  };
}

async function seedMissingRichProcessingStates(
  sqlClient: SqlClient,
  now: Date,
  limit = 25,
): Promise<number[]> {
  const nowIso = now.toISOString();
  const rows = (await sqlClient`
    INSERT INTO paper_processing_state (
      feed_item_id,
      source_hash,
      evidence_quality,
      full_text_status,
      deterministic_status,
      semantic_status,
      digest_ready,
      deterministic_attempt_count,
      semantic_attempt_count,
      deterministic_next_run_at,
      semantic_next_run_at,
      deterministic_last_error,
      semantic_last_error,
      lease_token,
      lease_expires_at,
      updated_at
    )
    SELECT
      fi.id,
      NULL,
      'unknown',
      CASE
        WHEN NULLIF(BTRIM(fi.full_text), '') IS NOT NULL THEN 'succeeded'
        ELSE 'stale'
      END,
      'pending',
      'pending',
      FALSE,
      0,
      0,
      ${nowIso}::timestamptz,
      ${nowIso}::timestamptz,
      NULL,
      NULL,
      NULL,
      NULL,
      ${nowIso}::timestamptz
    FROM feed_items fi
    LEFT JOIN paper_processing_state pps ON pps.feed_item_id = fi.id
    WHERE pps.feed_item_id IS NULL
      AND fi.source_type = 'paper'
      AND COALESCE(fi.corpus_tier, 'archive') <> 'ignored'
      AND COALESCE(fi.tier_metadata_json->>'ignored', 'false') <> 'true'
      AND COALESCE(fi.tier_metadata_json->>'manualTier', '') NOT IN ('archive', 'core_canon', 'ignored')
      AND (
        COALESCE(fi.corpus_tier, 'archive') = 'hot_set'
        OR COALESCE(fi.tier_metadata_json->>'pinned', 'false') = 'true'
        OR COALESCE(fi.tier_metadata_json->>'manualTier', '') = 'hot_set'
        OR (
          COALESCE(fi.tier_metadata_json->'retention'->>'pendingTier', '') = 'hot_set'
          AND CASE
            WHEN COALESCE(fi.tier_metadata_json->'retention'->>'intakeDefaultTier', '') <> 'hot_set'
            THEN TRUE
            WHEN COALESCE(
              NULLIF(fi.tier_metadata_json->'retention'->>'selectedAt', ''),
              NULLIF(fi.tier_metadata_json->'retention'->>'pendingReviewStartedAt', '')
            ) IS NULL
            THEN FALSE
            WHEN COALESCE(
              NULLIF(fi.tier_metadata_json->'retention'->>'pendingReviewStartedAt', '')::timestamptz,
              NULLIF(fi.tier_metadata_json->'retention'->>'selectedAt', '')::timestamptz
            ) >
              COALESCE(
                NULLIF(fi.tier_metadata_json->'retention'->>'selectedAt', '')::timestamptz,
                NULLIF(fi.tier_metadata_json->'retention'->>'pendingReviewStartedAt', '')::timestamptz
              ) + (
                CASE
                  WHEN COALESCE(fi.tier_metadata_json->'retention'->>'graceDays', '') ~ '^[0-9]+$'
                  THEN (fi.tier_metadata_json->'retention'->>'graceDays')::integer
                  ELSE 14
                END * INTERVAL '1 day'
              )
            THEN TRUE
            ELSE ${nowIso}::timestamptz BETWEEN
              COALESCE(
                NULLIF(fi.tier_metadata_json->'retention'->>'selectedAt', '')::timestamptz,
                NULLIF(fi.tier_metadata_json->'retention'->>'pendingReviewStartedAt', '')::timestamptz
              ) AND
              COALESCE(
                NULLIF(fi.tier_metadata_json->'retention'->>'selectedAt', '')::timestamptz,
                NULLIF(fi.tier_metadata_json->'retention'->>'pendingReviewStartedAt', '')::timestamptz
              ) + (
                CASE
                  WHEN COALESCE(fi.tier_metadata_json->'retention'->>'graceDays', '') ~ '^[0-9]+$'
                  THEN (fi.tier_metadata_json->'retention'->>'graceDays')::integer
                  ELSE 14
                END * INTERVAL '1 day'
              )
          END
        )
      )
    ORDER BY fi.published_at DESC NULLS LAST, fi.id DESC
    LIMIT ${limit}
    ON CONFLICT (feed_item_id) DO NOTHING
    RETURNING feed_item_id
  `) as Array<{ feed_item_id: number | string }>;

  return rows.map((row) => toInteger(row.feed_item_id));
}

export async function reconcilePendingHotSetPromotions(
  sqlClient: SqlClient,
  {
    now = new Date(),
    limit = 50,
  }: {
    now?: Date;
    limit?: number;
  } = {},
): Promise<HotSetProcessingEnqueueResult> {
  const nowIso = now.toISOString();
  const rows = (await sqlClient`
    SELECT fi.id
    FROM feed_items fi
    WHERE fi.source_type = 'paper'
      AND COALESCE(fi.tier_metadata_json->'retention'->>'pendingTier', '') = 'hot_set'
      AND CASE
        WHEN COALESCE(fi.tier_metadata_json->'retention'->>'intakeDefaultTier', '') <> 'hot_set'
        THEN TRUE
        WHEN COALESCE(
          NULLIF(fi.tier_metadata_json->'retention'->>'selectedAt', ''),
          NULLIF(fi.tier_metadata_json->'retention'->>'pendingReviewStartedAt', '')
        ) IS NULL
        THEN FALSE
        WHEN COALESCE(
          NULLIF(fi.tier_metadata_json->'retention'->>'pendingReviewStartedAt', '')::timestamptz,
          NULLIF(fi.tier_metadata_json->'retention'->>'selectedAt', '')::timestamptz
        ) >
          COALESCE(
            NULLIF(fi.tier_metadata_json->'retention'->>'selectedAt', '')::timestamptz,
            NULLIF(fi.tier_metadata_json->'retention'->>'pendingReviewStartedAt', '')::timestamptz
          ) + (
            CASE
              WHEN COALESCE(fi.tier_metadata_json->'retention'->>'graceDays', '') ~ '^[0-9]+$'
              THEN (fi.tier_metadata_json->'retention'->>'graceDays')::integer
              ELSE 14
            END * INTERVAL '1 day'
          )
        THEN TRUE
        ELSE ${nowIso}::timestamptz BETWEEN
          COALESCE(
            NULLIF(fi.tier_metadata_json->'retention'->>'selectedAt', '')::timestamptz,
            NULLIF(fi.tier_metadata_json->'retention'->>'pendingReviewStartedAt', '')::timestamptz
          ) AND
          COALESCE(
            NULLIF(fi.tier_metadata_json->'retention'->>'selectedAt', '')::timestamptz,
            NULLIF(fi.tier_metadata_json->'retention'->>'pendingReviewStartedAt', '')::timestamptz
          ) + (
            CASE
              WHEN COALESCE(fi.tier_metadata_json->'retention'->>'graceDays', '') ~ '^[0-9]+$'
              THEN (fi.tier_metadata_json->'retention'->>'graceDays')::integer
              ELSE 14
            END * INTERVAL '1 day'
          )
      END
      AND COALESCE(fi.corpus_tier, 'archive') <> 'ignored'
      AND COALESCE(fi.tier_metadata_json->>'ignored', 'false') <> 'true'
      AND COALESCE(fi.tier_metadata_json->>'manualTier', '') NOT IN ('archive', 'core_canon', 'ignored')
    ORDER BY fi.published_at DESC NULLS LAST, fi.id DESC
    LIMIT ${limit}
  `) as Array<{ id: number | string }>;

  return enqueueHotSetProcessingForFeedItems(
    sqlClient,
    rows.map((row) => toInteger(row.id)),
    now,
  );
}

async function claimNextDeterministicPaperFromState(
  sqlClient: SqlClient,
  {
    now = new Date(),
    leaseMs = PAPER_DETERMINISTIC_LEASE_MS,
    leaseToken = randomUUID(),
  }: {
    now?: Date;
    leaseMs?: number;
    leaseToken?: string;
  } = {},
): Promise<ClaimedDeterministicPaper | null> {
  const nowIso = now.toISOString();
  const leaseExpiresAtIso = new Date(now.getTime() + leaseMs).toISOString();
  const rows = (await sqlClient`
    WITH candidate AS (
      SELECT pps.feed_item_id
      FROM paper_processing_state pps
      JOIN feed_items fi ON fi.id = pps.feed_item_id
      WHERE fi.source_type = 'paper'
        AND pps.deterministic_next_run_at <= ${nowIso}::timestamptz
        AND pps.deterministic_status IN ('pending', 'failed', 'stale', 'running')
        AND COALESCE(fi.corpus_tier, 'archive') <> 'ignored'
        AND COALESCE(fi.tier_metadata_json->>'ignored', 'false') <> 'true'
        AND COALESCE(fi.tier_metadata_json->>'manualTier', '') NOT IN ('archive', 'core_canon', 'ignored')
        AND (
          COALESCE(fi.corpus_tier, 'archive') = 'hot_set'
          OR COALESCE(fi.tier_metadata_json->>'pinned', 'false') = 'true'
          OR COALESCE(fi.tier_metadata_json->>'manualTier', '') = 'hot_set'
          OR (
            COALESCE(fi.tier_metadata_json->'retention'->>'pendingTier', '') = 'hot_set'
            AND CASE
              WHEN COALESCE(fi.tier_metadata_json->'retention'->>'intakeDefaultTier', '') <> 'hot_set'
              THEN TRUE
              WHEN COALESCE(
                NULLIF(fi.tier_metadata_json->'retention'->>'selectedAt', ''),
                NULLIF(fi.tier_metadata_json->'retention'->>'pendingReviewStartedAt', '')
              ) IS NULL
              THEN FALSE
              WHEN COALESCE(
                NULLIF(fi.tier_metadata_json->'retention'->>'pendingReviewStartedAt', '')::timestamptz,
                NULLIF(fi.tier_metadata_json->'retention'->>'selectedAt', '')::timestamptz
              ) >
                COALESCE(
                  NULLIF(fi.tier_metadata_json->'retention'->>'selectedAt', '')::timestamptz,
                  NULLIF(fi.tier_metadata_json->'retention'->>'pendingReviewStartedAt', '')::timestamptz
                ) + (
                  CASE
                    WHEN COALESCE(fi.tier_metadata_json->'retention'->>'graceDays', '') ~ '^[0-9]+$'
                    THEN (fi.tier_metadata_json->'retention'->>'graceDays')::integer
                    ELSE 14
                  END * INTERVAL '1 day'
                )
              THEN TRUE
              ELSE ${nowIso}::timestamptz BETWEEN
                COALESCE(
                  NULLIF(fi.tier_metadata_json->'retention'->>'selectedAt', '')::timestamptz,
                  NULLIF(fi.tier_metadata_json->'retention'->>'pendingReviewStartedAt', '')::timestamptz
                ) AND
                COALESCE(
                  NULLIF(fi.tier_metadata_json->'retention'->>'selectedAt', '')::timestamptz,
                  NULLIF(fi.tier_metadata_json->'retention'->>'pendingReviewStartedAt', '')::timestamptz
                ) + (
                  CASE
                    WHEN COALESCE(fi.tier_metadata_json->'retention'->>'graceDays', '') ~ '^[0-9]+$'
                    THEN (fi.tier_metadata_json->'retention'->>'graceDays')::integer
                    ELSE 14
                  END * INTERVAL '1 day'
                )
            END
          )
        )
        AND (
          pps.lease_expires_at IS NULL
          OR pps.lease_expires_at < ${nowIso}::timestamptz
        )
      ORDER BY fi.published_at DESC NULLS LAST, fi.id DESC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE paper_processing_state pps
    SET deterministic_status = 'running',
        lease_token = ${leaseToken},
        lease_expires_at = ${leaseExpiresAtIso}::timestamptz,
        last_started_at = ${nowIso}::timestamptz,
        updated_at = ${nowIso}::timestamptz
    FROM candidate
    JOIN feed_items fi ON fi.id = candidate.feed_item_id
    WHERE pps.feed_item_id = candidate.feed_item_id
    RETURNING
      pps.*,
      fi.id AS paper_id,
      fi.external_id AS paper_external_id,
      fi.source_type AS paper_source_type,
      fi.title AS paper_title,
      fi.content AS paper_content,
      fi.url AS paper_url,
      fi.author_name AS paper_author_name,
      fi.author_handle AS paper_author_handle,
      fi.published_at AS paper_published_at,
      fi.corpus_tier AS paper_corpus_tier,
      fi.paper_meta AS paper_meta,
      fi.tier_metadata_json AS paper_tier_metadata_json,
      fi.full_text AS paper_full_text,
      fi.full_text_source AS paper_full_text_source
  `) as Array<
    PaperProcessingState & {
      paper_id: number | string;
      paper_external_id: string;
      paper_source_type: FeedItemSourceType;
      paper_title: string | null;
      paper_content: string;
      paper_url: string;
      paper_author_name: string;
      paper_author_handle: string | null;
      paper_published_at: string | Date | null;
      paper_corpus_tier: CorpusTier | null;
      paper_meta: PaperMeta | null;
      paper_tier_metadata_json: PaperCorpusTierMetadata | null;
      paper_full_text: string | null;
      paper_full_text_source: "arxiv_html" | "hf_page" | null;
    }
  >;
  const row = rows[0];
  if (!row) {
    return null;
  }

  return {
    leaseToken,
    state: toStateRow(row),
    paper: {
      id: toInteger(row.paper_id),
      external_id: row.paper_external_id,
      source_type: row.paper_source_type,
      title: row.paper_title,
      content: row.paper_content,
      url: row.paper_url,
      author_name: row.paper_author_name,
      author_handle: row.paper_author_handle,
      published_at: row.paper_published_at,
      corpus_tier: row.paper_corpus_tier,
      paper_meta: row.paper_meta,
      tier_metadata_json: row.paper_tier_metadata_json,
      full_text: row.paper_full_text,
      full_text_source: row.paper_full_text_source,
    },
  };
}

export async function claimNextDeterministicPaper(
  sqlClient: SqlClient,
  {
    now = new Date(),
    leaseMs = PAPER_DETERMINISTIC_LEASE_MS,
    leaseToken = randomUUID(),
  }: {
    now?: Date;
    leaseMs?: number;
    leaseToken?: string;
  } = {},
): Promise<ClaimedDeterministicPaper | null> {
  const existingClaim = await claimNextDeterministicPaperFromState(sqlClient, {
    now,
    leaseMs,
    leaseToken,
  });
  if (existingClaim) {
    return existingClaim;
  }

  await seedMissingRichProcessingStates(sqlClient, now);
  const seededClaim = await claimNextDeterministicPaperFromState(sqlClient, {
    now,
    leaseMs,
    leaseToken,
  });
  if (seededClaim) {
    return seededClaim;
  }

  await reconcilePendingHotSetPromotions(sqlClient, { now });

  return claimNextDeterministicPaperFromState(sqlClient, {
    now,
    leaseMs,
    leaseToken,
  });
}

export async function claimDeterministicPaperByFeedItemId(
  sqlClient: SqlClient,
  feedItemId: number,
  {
    now = new Date(),
    leaseMs = PAPER_DETERMINISTIC_LEASE_MS,
    leaseToken = randomUUID(),
  }: {
    now?: Date;
    leaseMs?: number;
    leaseToken?: string;
  } = {},
): Promise<ClaimedDeterministicPaper | null> {
  const nowIso = now.toISOString();
  const leaseExpiresAtIso = new Date(now.getTime() + leaseMs).toISOString();
  const rows = (await sqlClient`
    WITH candidate AS (
      SELECT pps.feed_item_id
      FROM paper_processing_state pps
      JOIN feed_items fi ON fi.id = pps.feed_item_id
      WHERE pps.feed_item_id = ${feedItemId}
        AND fi.source_type = 'paper'
        AND pps.deterministic_next_run_at <= ${nowIso}::timestamptz
        AND pps.deterministic_status IN ('pending', 'failed', 'stale', 'running')
        AND COALESCE(fi.corpus_tier, 'archive') <> 'ignored'
        AND COALESCE(fi.tier_metadata_json->>'ignored', 'false') <> 'true'
        AND COALESCE(fi.tier_metadata_json->>'manualTier', '') NOT IN ('archive', 'core_canon', 'ignored')
        AND (
          COALESCE(fi.corpus_tier, 'archive') = 'hot_set'
          OR COALESCE(fi.tier_metadata_json->>'pinned', 'false') = 'true'
          OR COALESCE(fi.tier_metadata_json->>'manualTier', '') = 'hot_set'
          OR (
            COALESCE(fi.tier_metadata_json->'retention'->>'pendingTier', '') = 'hot_set'
            AND CASE
              WHEN COALESCE(fi.tier_metadata_json->'retention'->>'intakeDefaultTier', '') <> 'hot_set'
              THEN TRUE
              WHEN COALESCE(
                NULLIF(fi.tier_metadata_json->'retention'->>'selectedAt', ''),
                NULLIF(fi.tier_metadata_json->'retention'->>'pendingReviewStartedAt', '')
              ) IS NULL
              THEN FALSE
              WHEN COALESCE(
                NULLIF(fi.tier_metadata_json->'retention'->>'pendingReviewStartedAt', '')::timestamptz,
                NULLIF(fi.tier_metadata_json->'retention'->>'selectedAt', '')::timestamptz
              ) >
                COALESCE(
                  NULLIF(fi.tier_metadata_json->'retention'->>'selectedAt', '')::timestamptz,
                  NULLIF(fi.tier_metadata_json->'retention'->>'pendingReviewStartedAt', '')::timestamptz
                ) + (
                  CASE
                    WHEN COALESCE(fi.tier_metadata_json->'retention'->>'graceDays', '') ~ '^[0-9]+$'
                    THEN (fi.tier_metadata_json->'retention'->>'graceDays')::integer
                    ELSE 14
                  END * INTERVAL '1 day'
                )
              THEN TRUE
              ELSE ${nowIso}::timestamptz BETWEEN
                COALESCE(
                  NULLIF(fi.tier_metadata_json->'retention'->>'selectedAt', '')::timestamptz,
                  NULLIF(fi.tier_metadata_json->'retention'->>'pendingReviewStartedAt', '')::timestamptz
                ) AND
                COALESCE(
                  NULLIF(fi.tier_metadata_json->'retention'->>'selectedAt', '')::timestamptz,
                  NULLIF(fi.tier_metadata_json->'retention'->>'pendingReviewStartedAt', '')::timestamptz
                ) + (
                  CASE
                    WHEN COALESCE(fi.tier_metadata_json->'retention'->>'graceDays', '') ~ '^[0-9]+$'
                    THEN (fi.tier_metadata_json->'retention'->>'graceDays')::integer
                    ELSE 14
                  END * INTERVAL '1 day'
                )
            END
          )
        )
        AND (
          pps.lease_expires_at IS NULL
          OR pps.lease_expires_at < ${nowIso}::timestamptz
        )
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE paper_processing_state pps
    SET deterministic_status = 'running',
        lease_token = ${leaseToken},
        lease_expires_at = ${leaseExpiresAtIso}::timestamptz,
        last_started_at = ${nowIso}::timestamptz,
        updated_at = ${nowIso}::timestamptz
    FROM candidate
    JOIN feed_items fi ON fi.id = candidate.feed_item_id
    WHERE pps.feed_item_id = candidate.feed_item_id
    RETURNING
      pps.*,
      fi.id AS paper_id,
      fi.external_id AS paper_external_id,
      fi.source_type AS paper_source_type,
      fi.title AS paper_title,
      fi.content AS paper_content,
      fi.url AS paper_url,
      fi.author_name AS paper_author_name,
      fi.author_handle AS paper_author_handle,
      fi.published_at AS paper_published_at,
      fi.corpus_tier AS paper_corpus_tier,
      fi.paper_meta AS paper_meta,
      fi.tier_metadata_json AS paper_tier_metadata_json,
      fi.full_text AS paper_full_text,
      fi.full_text_source AS paper_full_text_source
  `) as Array<
    PaperProcessingState & {
      paper_id: number | string;
      paper_external_id: string;
      paper_source_type: FeedItemSourceType;
      paper_title: string | null;
      paper_content: string;
      paper_url: string;
      paper_author_name: string;
      paper_author_handle: string | null;
      paper_published_at: string | Date | null;
      paper_corpus_tier: CorpusTier | null;
      paper_meta: PaperMeta | null;
      paper_tier_metadata_json: PaperCorpusTierMetadata | null;
      paper_full_text: string | null;
      paper_full_text_source: "arxiv_html" | "hf_page" | null;
    }
  >;
  const row = rows[0];
  if (!row) {
    return null;
  }

  return {
    leaseToken,
    state: toStateRow(row),
    paper: {
      id: toInteger(row.paper_id),
      external_id: row.paper_external_id,
      source_type: row.paper_source_type,
      title: row.paper_title,
      content: row.paper_content,
      url: row.paper_url,
      author_name: row.paper_author_name,
      author_handle: row.paper_author_handle,
      published_at: row.paper_published_at,
      corpus_tier: row.paper_corpus_tier,
      paper_meta: row.paper_meta,
      tier_metadata_json: row.paper_tier_metadata_json,
      full_text: row.paper_full_text,
      full_text_source: row.paper_full_text_source,
    },
  };
}

export async function claimNextSemanticPaper(
  sqlClient: SqlClient,
  {
    now = new Date(),
    leaseMs = PAPER_SEMANTIC_LEASE_MS,
    leaseToken = randomUUID(),
  }: {
    now?: Date;
    leaseMs?: number;
    leaseToken?: string;
  } = {},
): Promise<ClaimedSemanticPaper | null> {
  const nowIso = now.toISOString();
  const leaseExpiresAtIso = new Date(now.getTime() + leaseMs).toISOString();
  const rows = (await sqlClient`
    WITH recent_digest_papers AS (
      SELECT COALESCE(
        array_agg(DISTINCT recent.feed_item_id),
        ARRAY[]::integer[]
      ) AS source_item_ids
      FROM digests d
      CROSS JOIN LATERAL unnest(
        COALESCE(d.source_item_ids, ARRAY[]::integer[])
      ) AS recent(feed_item_id)
      WHERE d.generated_at >= ${nowIso}::timestamptz - INTERVAL '72 hours'
    ),
    candidate AS (
      SELECT pps.feed_item_id
      FROM paper_processing_state pps
      JOIN feed_items fi ON fi.id = pps.feed_item_id
      CROSS JOIN recent_digest_papers rdp
      WHERE fi.source_type = 'paper'
        AND pps.deterministic_status = 'succeeded'
        AND fi.fetched_at > ${nowIso}::timestamptz - INTERVAL '24 hours'
        AND NOT (pps.feed_item_id = ANY(rdp.source_item_ids))
        AND pps.semantic_next_run_at <= ${nowIso}::timestamptz
        AND pps.semantic_status IN ('pending', 'failed', 'stale', 'running', 'skipped')
        AND COALESCE(pps.semantic_attempt_count, 0) < ${PAPER_SEMANTIC_MAX_ATTEMPTS}
        AND COALESCE(fi.corpus_tier, 'archive') <> 'ignored'
        AND COALESCE(fi.tier_metadata_json->>'ignored', 'false') <> 'true'
        AND COALESCE(fi.tier_metadata_json->>'manualTier', '') NOT IN ('archive', 'core_canon', 'ignored')
        AND (
          COALESCE(fi.corpus_tier, 'archive') = 'hot_set'
          OR COALESCE(fi.tier_metadata_json->>'pinned', 'false') = 'true'
          OR COALESCE(fi.tier_metadata_json->>'manualTier', '') = 'hot_set'
          OR (
            COALESCE(fi.tier_metadata_json->'retention'->>'pendingTier', '') = 'hot_set'
            AND CASE
              WHEN COALESCE(fi.tier_metadata_json->'retention'->>'intakeDefaultTier', '') <> 'hot_set'
              THEN TRUE
              WHEN COALESCE(
                NULLIF(fi.tier_metadata_json->'retention'->>'selectedAt', ''),
                NULLIF(fi.tier_metadata_json->'retention'->>'pendingReviewStartedAt', '')
              ) IS NULL
              THEN FALSE
              WHEN COALESCE(
                NULLIF(fi.tier_metadata_json->'retention'->>'pendingReviewStartedAt', '')::timestamptz,
                NULLIF(fi.tier_metadata_json->'retention'->>'selectedAt', '')::timestamptz
              ) >
                COALESCE(
                  NULLIF(fi.tier_metadata_json->'retention'->>'selectedAt', '')::timestamptz,
                  NULLIF(fi.tier_metadata_json->'retention'->>'pendingReviewStartedAt', '')::timestamptz
                ) + (
                  CASE
                    WHEN COALESCE(fi.tier_metadata_json->'retention'->>'graceDays', '') ~ '^[0-9]+$'
                    THEN (fi.tier_metadata_json->'retention'->>'graceDays')::integer
                    ELSE 14
                  END * INTERVAL '1 day'
                )
              THEN TRUE
              ELSE ${nowIso}::timestamptz BETWEEN
                COALESCE(
                  NULLIF(fi.tier_metadata_json->'retention'->>'selectedAt', '')::timestamptz,
                  NULLIF(fi.tier_metadata_json->'retention'->>'pendingReviewStartedAt', '')::timestamptz
                ) AND
                COALESCE(
                  NULLIF(fi.tier_metadata_json->'retention'->>'selectedAt', '')::timestamptz,
                  NULLIF(fi.tier_metadata_json->'retention'->>'pendingReviewStartedAt', '')::timestamptz
                ) + (
                  CASE
                    WHEN COALESCE(fi.tier_metadata_json->'retention'->>'graceDays', '') ~ '^[0-9]+$'
                    THEN (fi.tier_metadata_json->'retention'->>'graceDays')::integer
                    ELSE 14
                  END * INTERVAL '1 day'
                )
            END
          )
        )
        AND (
          pps.lease_expires_at IS NULL
          OR pps.lease_expires_at < ${nowIso}::timestamptz
        )
      ORDER BY
        CASE pps.semantic_status
          WHEN 'pending' THEN 0
          WHEN 'stale' THEN 0
          WHEN 'running' THEN 1
          WHEN 'failed' THEN 2
          ELSE 3
        END,
        fi.published_at DESC NULLS LAST,
        fi.id DESC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE paper_processing_state pps
    SET semantic_status = 'running',
        digest_ready = FALSE,
        lease_token = ${leaseToken},
        lease_expires_at = ${leaseExpiresAtIso}::timestamptz,
        last_started_at = ${nowIso}::timestamptz,
        updated_at = ${nowIso}::timestamptz
    FROM candidate
    JOIN feed_items fi ON fi.id = candidate.feed_item_id
    WHERE pps.feed_item_id = candidate.feed_item_id
    RETURNING
      pps.*,
      fi.id AS paper_id,
      fi.external_id AS paper_external_id,
      fi.source_type AS paper_source_type,
      fi.title AS paper_title,
      fi.content AS paper_content,
      fi.url AS paper_url,
      fi.author_name AS paper_author_name,
      fi.author_handle AS paper_author_handle,
      fi.published_at AS paper_published_at,
      fi.corpus_tier AS paper_corpus_tier,
      fi.paper_meta AS paper_meta,
      fi.tier_metadata_json AS paper_tier_metadata_json,
      fi.full_text AS paper_full_text,
      fi.full_text_source AS paper_full_text_source
  `) as Array<
    PaperProcessingState & {
      paper_id: number | string;
      paper_external_id: string;
      paper_source_type: FeedItemSourceType;
      paper_title: string | null;
      paper_content: string;
      paper_url: string;
      paper_author_name: string;
      paper_author_handle: string | null;
      paper_published_at: string | Date | null;
      paper_corpus_tier: CorpusTier | null;
      paper_meta: PaperMeta | null;
      paper_tier_metadata_json: PaperCorpusTierMetadata | null;
      paper_full_text: string | null;
      paper_full_text_source: "arxiv_html" | "hf_page" | null;
    }
  >;
  const row = rows[0];
  if (!row) {
    return null;
  }

  return {
    leaseToken,
    state: toStateRow(row),
    paper: {
      id: toInteger(row.paper_id),
      external_id: row.paper_external_id,
      source_type: row.paper_source_type,
      title: row.paper_title,
      content: row.paper_content,
      url: row.paper_url,
      author_name: row.paper_author_name,
      author_handle: row.paper_author_handle,
      published_at: row.paper_published_at,
      corpus_tier: row.paper_corpus_tier,
      paper_meta: row.paper_meta,
      tier_metadata_json: row.paper_tier_metadata_json,
      full_text: row.paper_full_text,
      full_text_source: row.paper_full_text_source,
    },
  };
}

export async function claimSemanticPaperByFeedItemId(
  sqlClient: SqlClient,
  feedItemId: number,
  {
    now = new Date(),
    leaseMs = PAPER_SEMANTIC_LEASE_MS,
    leaseToken = randomUUID(),
  }: {
    now?: Date;
    leaseMs?: number;
    leaseToken?: string;
  } = {},
): Promise<ClaimedSemanticPaper | null> {
  const nowIso = now.toISOString();
  const leaseExpiresAtIso = new Date(now.getTime() + leaseMs).toISOString();
  const rows = (await sqlClient`
    WITH candidate AS (
      SELECT pps.feed_item_id
      FROM paper_processing_state pps
      JOIN feed_items fi ON fi.id = pps.feed_item_id
      WHERE pps.feed_item_id = ${feedItemId}
        AND fi.source_type = 'paper'
        AND pps.deterministic_status = 'succeeded'
        AND pps.semantic_next_run_at <= ${nowIso}::timestamptz
        AND pps.semantic_status IN ('pending', 'failed', 'stale', 'running', 'skipped')
        AND COALESCE(pps.semantic_attempt_count, 0) < ${PAPER_SEMANTIC_MAX_ATTEMPTS}
        AND COALESCE(fi.corpus_tier, 'archive') <> 'ignored'
        AND COALESCE(fi.tier_metadata_json->>'ignored', 'false') <> 'true'
        AND COALESCE(fi.tier_metadata_json->>'manualTier', '') NOT IN ('archive', 'core_canon', 'ignored')
        AND (
          COALESCE(fi.corpus_tier, 'archive') = 'hot_set'
          OR COALESCE(fi.tier_metadata_json->>'pinned', 'false') = 'true'
          OR COALESCE(fi.tier_metadata_json->>'manualTier', '') = 'hot_set'
          OR (
            COALESCE(fi.tier_metadata_json->'retention'->>'pendingTier', '') = 'hot_set'
            AND CASE
              WHEN COALESCE(fi.tier_metadata_json->'retention'->>'intakeDefaultTier', '') <> 'hot_set'
              THEN TRUE
              WHEN COALESCE(
                NULLIF(fi.tier_metadata_json->'retention'->>'selectedAt', ''),
                NULLIF(fi.tier_metadata_json->'retention'->>'pendingReviewStartedAt', '')
              ) IS NULL
              THEN FALSE
              WHEN COALESCE(
                NULLIF(fi.tier_metadata_json->'retention'->>'pendingReviewStartedAt', '')::timestamptz,
                NULLIF(fi.tier_metadata_json->'retention'->>'selectedAt', '')::timestamptz
              ) >
                COALESCE(
                  NULLIF(fi.tier_metadata_json->'retention'->>'selectedAt', '')::timestamptz,
                  NULLIF(fi.tier_metadata_json->'retention'->>'pendingReviewStartedAt', '')::timestamptz
                ) + (
                  CASE
                    WHEN COALESCE(fi.tier_metadata_json->'retention'->>'graceDays', '') ~ '^[0-9]+$'
                    THEN (fi.tier_metadata_json->'retention'->>'graceDays')::integer
                    ELSE 14
                  END * INTERVAL '1 day'
                )
              THEN TRUE
              ELSE ${nowIso}::timestamptz BETWEEN
                COALESCE(
                  NULLIF(fi.tier_metadata_json->'retention'->>'selectedAt', '')::timestamptz,
                  NULLIF(fi.tier_metadata_json->'retention'->>'pendingReviewStartedAt', '')::timestamptz
                ) AND
                COALESCE(
                  NULLIF(fi.tier_metadata_json->'retention'->>'selectedAt', '')::timestamptz,
                  NULLIF(fi.tier_metadata_json->'retention'->>'pendingReviewStartedAt', '')::timestamptz
                ) + (
                  CASE
                    WHEN COALESCE(fi.tier_metadata_json->'retention'->>'graceDays', '') ~ '^[0-9]+$'
                    THEN (fi.tier_metadata_json->'retention'->>'graceDays')::integer
                    ELSE 14
                  END * INTERVAL '1 day'
                )
            END
          )
        )
        AND (
          pps.lease_expires_at IS NULL
          OR pps.lease_expires_at < ${nowIso}::timestamptz
        )
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE paper_processing_state pps
    SET semantic_status = 'running',
        digest_ready = FALSE,
        lease_token = ${leaseToken},
        lease_expires_at = ${leaseExpiresAtIso}::timestamptz,
        last_started_at = ${nowIso}::timestamptz,
        updated_at = ${nowIso}::timestamptz
    FROM candidate
    JOIN feed_items fi ON fi.id = candidate.feed_item_id
    WHERE pps.feed_item_id = candidate.feed_item_id
    RETURNING
      pps.*,
      fi.id AS paper_id,
      fi.external_id AS paper_external_id,
      fi.source_type AS paper_source_type,
      fi.title AS paper_title,
      fi.content AS paper_content,
      fi.url AS paper_url,
      fi.author_name AS paper_author_name,
      fi.author_handle AS paper_author_handle,
      fi.published_at AS paper_published_at,
      fi.corpus_tier AS paper_corpus_tier,
      fi.paper_meta AS paper_meta,
      fi.tier_metadata_json AS paper_tier_metadata_json,
      fi.full_text AS paper_full_text,
      fi.full_text_source AS paper_full_text_source
  `) as Array<
    PaperProcessingState & {
      paper_id: number | string;
      paper_external_id: string;
      paper_source_type: FeedItemSourceType;
      paper_title: string | null;
      paper_content: string;
      paper_url: string;
      paper_author_name: string;
      paper_author_handle: string | null;
      paper_published_at: string | Date | null;
      paper_corpus_tier: CorpusTier | null;
      paper_meta: PaperMeta | null;
      paper_tier_metadata_json: PaperCorpusTierMetadata | null;
      paper_full_text: string | null;
      paper_full_text_source: "arxiv_html" | "hf_page" | null;
    }
  >;
  const row = rows[0];
  if (!row) {
    return null;
  }

  return {
    leaseToken,
    state: toStateRow(row),
    paper: {
      id: toInteger(row.paper_id),
      external_id: row.paper_external_id,
      source_type: row.paper_source_type,
      title: row.paper_title,
      content: row.paper_content,
      url: row.paper_url,
      author_name: row.paper_author_name,
      author_handle: row.paper_author_handle,
      published_at: row.paper_published_at,
      corpus_tier: row.paper_corpus_tier,
      paper_meta: row.paper_meta,
      tier_metadata_json: row.paper_tier_metadata_json,
      full_text: row.paper_full_text,
      full_text_source: row.paper_full_text_source,
    },
  };
}

export async function enqueueHotSetProcessingForFeedItems(
  sqlClient: SqlClient,
  feedItemIds: number[],
  now: Date = new Date(),
): Promise<HotSetProcessingEnqueueResult> {
  const requestedFeedItemIds = [...new Set(
    feedItemIds
      .map((id) => Math.trunc(id))
      .filter((id) => Number.isInteger(id) && id > 0),
  )];
  if (requestedFeedItemIds.length === 0) {
    return {
      requestedFeedItemIds,
      enqueuedFeedItemIds: [],
      enqueuedCount: 0,
      finalizedFeedItemIds: [],
      finalizedCount: 0,
    };
  }

  const nowIso = now.toISOString();
  const evidenceCounts = await loadRichEvidenceCounts(sqlClient, requestedFeedItemIds);
  const rows = (await sqlClient`
    WITH requested AS (
      SELECT unnest(${requestedFeedItemIds}::int[]) AS feed_item_id
    ),
    evidence_counts AS (
      SELECT
        (item->>'feedItemId')::bigint AS feed_item_id,
        COALESCE((item->>'sectionCount')::integer, 0) AS section_count,
        COALESCE((item->>'spanCount')::integer, 0) AS span_count,
        COALESCE((item->>'cardCount')::integer, 0) AS card_count,
        COALESCE((item->>'profileCount')::integer, 0) AS profile_count
      FROM jsonb_array_elements(${JSON.stringify(evidenceCounts)}::jsonb) AS evidence_count_items(item)
    ),
    eligible AS (
      SELECT
        fi.id AS feed_item_id,
        fi.full_text,
        pps.source_hash,
        pps.evidence_quality,
        pps.full_text_status,
        pps.deterministic_status,
        pps.semantic_status,
        pps.digest_ready,
        pps.deterministic_attempt_count,
        pps.semantic_attempt_count,
        COALESCE(evidence_counts.section_count, 0) AS section_count,
        COALESCE(evidence_counts.span_count, 0) AS span_count,
        COALESCE(evidence_counts.card_count, 0) AS card_count,
        COALESCE(evidence_counts.profile_count, 0) AS profile_count
      FROM requested
      JOIN feed_items fi ON fi.id = requested.feed_item_id
      LEFT JOIN paper_processing_state pps ON pps.feed_item_id = fi.id
      LEFT JOIN evidence_counts ON evidence_counts.feed_item_id = fi.id
      WHERE fi.source_type = 'paper'
        AND COALESCE(fi.corpus_tier, 'archive') <> 'ignored'
        AND COALESCE(fi.tier_metadata_json->>'ignored', 'false') <> 'true'
        AND COALESCE(fi.tier_metadata_json->>'manualTier', '') NOT IN ('archive', 'core_canon', 'ignored')
        AND (
          COALESCE(fi.corpus_tier, 'archive') = 'hot_set'
          OR COALESCE(fi.tier_metadata_json->>'pinned', 'false') = 'true'
          OR COALESCE(fi.tier_metadata_json->>'manualTier', '') = 'hot_set'
          OR (
            COALESCE(fi.tier_metadata_json->'retention'->>'pendingTier', '') = 'hot_set'
            AND CASE
              WHEN COALESCE(fi.tier_metadata_json->'retention'->>'intakeDefaultTier', '') <> 'hot_set'
              THEN TRUE
              WHEN COALESCE(
                NULLIF(fi.tier_metadata_json->'retention'->>'selectedAt', ''),
                NULLIF(fi.tier_metadata_json->'retention'->>'pendingReviewStartedAt', '')
              ) IS NULL
              THEN FALSE
              WHEN COALESCE(
                NULLIF(fi.tier_metadata_json->'retention'->>'pendingReviewStartedAt', '')::timestamptz,
                NULLIF(fi.tier_metadata_json->'retention'->>'selectedAt', '')::timestamptz
              ) >
                COALESCE(
                  NULLIF(fi.tier_metadata_json->'retention'->>'selectedAt', '')::timestamptz,
                  NULLIF(fi.tier_metadata_json->'retention'->>'pendingReviewStartedAt', '')::timestamptz
                ) + (
                  CASE
                    WHEN COALESCE(fi.tier_metadata_json->'retention'->>'graceDays', '') ~ '^[0-9]+$'
                    THEN (fi.tier_metadata_json->'retention'->>'graceDays')::integer
                    ELSE 14
                  END * INTERVAL '1 day'
                )
              THEN TRUE
              ELSE ${nowIso}::timestamptz BETWEEN
                COALESCE(
                  NULLIF(fi.tier_metadata_json->'retention'->>'selectedAt', '')::timestamptz,
                  NULLIF(fi.tier_metadata_json->'retention'->>'pendingReviewStartedAt', '')::timestamptz
                ) AND
                COALESCE(
                  NULLIF(fi.tier_metadata_json->'retention'->>'selectedAt', '')::timestamptz,
                  NULLIF(fi.tier_metadata_json->'retention'->>'pendingReviewStartedAt', '')::timestamptz
                ) + (
                  CASE
                    WHEN COALESCE(fi.tier_metadata_json->'retention'->>'graceDays', '') ~ '^[0-9]+$'
                    THEN (fi.tier_metadata_json->'retention'->>'graceDays')::integer
                    ELSE 14
                  END * INTERVAL '1 day'
                )
            END
          )
        )
    ),
    work AS (
      SELECT
        *,
        (
          source_hash IS NULL
          OR deterministic_status IS NULL
          OR deterministic_status <> 'succeeded'
          OR section_count <= 0
          OR span_count <= 0
          OR card_count <= 0
          OR profile_count <= 0
        ) AS deterministic_needed,
        (
          semantic_status IS NULL
          OR semantic_status <> 'succeeded'
          OR digest_ready IS DISTINCT FROM TRUE
        ) AS semantic_needed
      FROM eligible
    ),
    enqueued AS (
      INSERT INTO paper_processing_state (
        feed_item_id,
        source_hash,
        evidence_quality,
        full_text_status,
        deterministic_status,
        semantic_status,
        digest_ready,
        deterministic_attempt_count,
        semantic_attempt_count,
        deterministic_next_run_at,
        semantic_next_run_at,
        deterministic_last_error,
        semantic_last_error,
        lease_token,
        lease_expires_at,
        updated_at
      )
      SELECT
        feed_item_id,
        source_hash,
        CASE
          WHEN deterministic_needed THEN 'unknown'
          ELSE COALESCE(evidence_quality, 'unknown')
        END,
        CASE
          WHEN deterministic_needed THEN
            CASE
              WHEN NULLIF(BTRIM(full_text), '') IS NOT NULL THEN 'succeeded'
              ELSE 'stale'
            END
          ELSE COALESCE(full_text_status, 'pending')
        END,
        CASE
          WHEN deterministic_needed THEN 'stale'
          ELSE COALESCE(deterministic_status, 'pending')
        END,
        CASE
          WHEN deterministic_needed OR semantic_needed THEN 'stale'
          ELSE COALESCE(semantic_status, 'pending')
        END,
        CASE
          WHEN deterministic_needed OR semantic_needed THEN FALSE
          ELSE COALESCE(digest_ready, FALSE)
        END,
        CASE
          WHEN deterministic_needed THEN 0
          ELSE COALESCE(deterministic_attempt_count, 0)
        END,
        CASE
          WHEN deterministic_needed OR semantic_needed THEN 0
          ELSE COALESCE(semantic_attempt_count, 0)
        END,
        ${nowIso}::timestamptz,
        ${nowIso}::timestamptz,
        NULL,
        NULL,
        NULL,
        NULL,
        ${nowIso}::timestamptz
      FROM work
      WHERE deterministic_needed OR semantic_needed
      ON CONFLICT (feed_item_id) DO UPDATE
      SET evidence_quality = EXCLUDED.evidence_quality,
          full_text_status = EXCLUDED.full_text_status,
          deterministic_status = EXCLUDED.deterministic_status,
          semantic_status = EXCLUDED.semantic_status,
          digest_ready = EXCLUDED.digest_ready,
          deterministic_attempt_count = EXCLUDED.deterministic_attempt_count,
          semantic_attempt_count = EXCLUDED.semantic_attempt_count,
          deterministic_next_run_at = EXCLUDED.deterministic_next_run_at,
          semantic_next_run_at = EXCLUDED.semantic_next_run_at,
          deterministic_last_error = NULL,
          semantic_last_error = NULL,
          lease_token = NULL,
          lease_expires_at = NULL,
          updated_at = EXCLUDED.updated_at
      WHERE paper_processing_state.lease_expires_at IS NULL
         OR paper_processing_state.lease_expires_at < ${nowIso}::timestamptz
      RETURNING feed_item_id
    )
    SELECT feed_item_id
    FROM enqueued
    ORDER BY feed_item_id
  `) as Array<{ feed_item_id: number | string }>;

  const enqueuedFeedItemIds = rows.map((row) => toInteger(row.feed_item_id));
  const finalizedFeedItemIds = await finalizeCompletedPendingHotSetPromotions(
    sqlClient,
    requestedFeedItemIds,
    now,
  );
  return {
    requestedFeedItemIds,
    enqueuedFeedItemIds,
    enqueuedCount: enqueuedFeedItemIds.length,
    finalizedFeedItemIds,
    finalizedCount: finalizedFeedItemIds.length,
  };
}

export async function finalizeCompletedPendingHotSetPromotions(
  sqlClient: SqlClient,
  feedItemIds: number[],
  now: Date = new Date(),
): Promise<number[]> {
  const requestedFeedItemIds = [...new Set(
    feedItemIds
      .map((id) => Math.trunc(id))
      .filter((id) => Number.isInteger(id) && id > 0),
  )];
  if (requestedFeedItemIds.length === 0) {
    return [];
  }

  const nowIso = now.toISOString();
  const evidenceCounts = await loadRichEvidenceCounts(sqlClient, requestedFeedItemIds);
  const rows = (await sqlClient`
    WITH requested AS (
      SELECT unnest(${requestedFeedItemIds}::int[]) AS feed_item_id
    ),
    evidence_counts AS (
      SELECT
        (item->>'feedItemId')::bigint AS feed_item_id,
        COALESCE((item->>'sectionCount')::integer, 0) AS section_count,
        COALESCE((item->>'spanCount')::integer, 0) AS span_count,
        COALESCE((item->>'cardCount')::integer, 0) AS card_count,
        COALESCE((item->>'profileCount')::integer, 0) AS profile_count
      FROM jsonb_array_elements(${JSON.stringify(evidenceCounts)}::jsonb) AS evidence_count_items(item)
    ),
    ready AS (
      SELECT
        fi.id AS feed_item_id,
        fi.tier_metadata_json,
        NULLIF(fi.tier_metadata_json->'retention'->>'pendingReviewRunId', '')::bigint AS pending_review_run_id
      FROM requested
      JOIN feed_items fi ON fi.id = requested.feed_item_id
      JOIN paper_processing_state pps ON pps.feed_item_id = fi.id
      LEFT JOIN evidence_counts ON evidence_counts.feed_item_id = fi.id
      CROSS JOIN LATERAL (
        SELECT
          CASE
            WHEN COALESCE(fi.tier_metadata_json->'retention'->>'intakeDefaultTier', '') = 'hot_set'
            THEN COALESCE(
              NULLIF(fi.tier_metadata_json->'retention'->>'selectedAt', '')::timestamptz,
              NULLIF(fi.tier_metadata_json->'retention'->>'pendingReviewStartedAt', '')::timestamptz
            )
            ELSE NULL
          END AS selected_at,
          CASE
            WHEN COALESCE(fi.tier_metadata_json->'retention'->>'intakeDefaultTier', '') = 'hot_set'
            THEN COALESCE(
              NULLIF(fi.tier_metadata_json->'retention'->>'pendingReviewStartedAt', '')::timestamptz,
              NULLIF(fi.tier_metadata_json->'retention'->>'selectedAt', '')::timestamptz
            )
            ELSE NULL
          END AS pending_started_at,
          CASE
            WHEN COALESCE(fi.tier_metadata_json->'retention'->>'graceDays', '') ~ '^[0-9]+$'
            THEN (fi.tier_metadata_json->'retention'->>'graceDays')::integer
            ELSE 14
          END AS grace_days
      ) AS intake_grace
      WHERE fi.source_type = 'paper'
        AND COALESCE(fi.tier_metadata_json->'retention'->>'pendingTier', '') = 'hot_set'
        AND COALESCE(fi.corpus_tier, 'archive') <> 'ignored'
        AND COALESCE(fi.tier_metadata_json->>'ignored', 'false') <> 'true'
        AND COALESCE(fi.tier_metadata_json->>'manualTier', '') NOT IN ('archive', 'core_canon', 'ignored')
        AND CASE
          WHEN COALESCE(fi.tier_metadata_json->'retention'->>'intakeDefaultTier', '') <> 'hot_set'
          THEN TRUE
          WHEN intake_grace.selected_at IS NULL
          THEN FALSE
          WHEN intake_grace.pending_started_at >
            intake_grace.selected_at + (intake_grace.grace_days * INTERVAL '1 day')
          THEN TRUE
          ELSE ${nowIso}::timestamptz >= intake_grace.selected_at
            AND ${nowIso}::timestamptz <=
              intake_grace.selected_at + (intake_grace.grace_days * INTERVAL '1 day')
        END
        AND pps.deterministic_status = 'succeeded'
        AND pps.semantic_status = 'succeeded'
        AND pps.digest_ready = TRUE
        AND COALESCE(evidence_counts.section_count, 0) > 0
        AND COALESCE(evidence_counts.span_count, 0) > 0
        AND COALESCE(evidence_counts.card_count, 0) > 0
        AND COALESCE(evidence_counts.profile_count, 0) > 0
    )
    UPDATE feed_items fi
    SET corpus_tier = 'hot_set',
        hot_set_reason = COALESCE(
          fi.hot_set_reason,
          'rich processing complete for pending Hot Set promotion'
        ),
        archive_reason = NULL,
        last_scored_at = COALESCE(fi.last_scored_at, ${nowIso}::timestamptz),
        tier_metadata_json = jsonb_set(
          COALESCE(fi.tier_metadata_json, '{}'::jsonb) ||
            jsonb_build_object(
              'lastReviewAction',
              COALESCE(
                fi.tier_metadata_json->'retention'->>'pendingReviewAction',
                'pending_to_hot_set'
              )
            ),
          '{retention}',
          (
            COALESCE(fi.tier_metadata_json->'retention', '{}'::jsonb)
            - 'pendingTier'
            - 'pendingSourceTier'
            - 'pendingReviewRunId'
            - 'pendingReviewAction'
            - 'pendingReviewStartedAt'
            - 'pendingReviewReasons'
          ) || jsonb_build_object(
            'hotSetReadyAt',
            ${nowIso}::text,
            'hotSetReadyReviewRunId',
            ready.pending_review_run_id
          )
        )
    FROM ready
    WHERE fi.id = ready.feed_item_id
    RETURNING fi.id
  `) as Array<{ id: number | string }>;

  return rows.map((row) => toInteger(row.id));
}

async function rescheduleSemanticFinalizationFailure(
  sqlClient: SqlClient,
  feedItemId: number,
  error: unknown,
  now: Date,
  previousAttemptCount: number,
): Promise<PaperProcessingState | null> {
  const nextAttemptCount = previousAttemptCount + 1;
  const nowIso = now.toISOString();
  const nextRunAt = calculateRetryNextRunAt(nextAttemptCount, now);
  const nextRunAtIso = nextRunAt?.toISOString() ?? nowIso;

  if (nextAttemptCount >= PAPER_SEMANTIC_MAX_ATTEMPTS) {
    const rows = (await sqlClient`
      UPDATE paper_processing_state
      SET semantic_status = 'dead',
          digest_ready = FALSE,
          semantic_attempt_count = ${nextAttemptCount},
          semantic_next_run_at = ${nowIso}::timestamptz,
          semantic_last_error = ${truncateError(error)},
          lease_token = NULL,
          lease_expires_at = NULL,
          last_failed_at = ${nowIso}::timestamptz,
          updated_at = ${nowIso}::timestamptz
      WHERE feed_item_id = ${feedItemId}
        AND semantic_status = 'succeeded'
      RETURNING *
    `) as PaperProcessingState[];

    return rows[0] ? toStateRow(rows[0]) : null;
  }

  const rows = (await sqlClient`
    UPDATE paper_processing_state
    SET semantic_status = 'failed',
        digest_ready = FALSE,
        semantic_attempt_count = ${nextAttemptCount},
        semantic_next_run_at = ${nextRunAtIso}::timestamptz,
        semantic_last_error = ${truncateError(error)},
        lease_token = NULL,
        lease_expires_at = NULL,
        last_failed_at = ${nowIso}::timestamptz,
        updated_at = ${nowIso}::timestamptz
    WHERE feed_item_id = ${feedItemId}
      AND semantic_status = 'succeeded'
    RETURNING *
  `) as PaperProcessingState[];

  return rows[0] ? toStateRow(rows[0]) : null;
}

export async function markDeterministicProcessingSucceeded(
  sqlClient: SqlClient,
  {
    feedItemId,
    leaseToken,
    sourceHash,
    expectedSourceHash,
    evidenceQuality,
    fullTextStatus,
    now = new Date(),
  }: {
    feedItemId: number;
    leaseToken?: string | null;
    sourceHash: string;
    expectedSourceHash?: string | null;
    evidenceQuality: PaperEvidenceQuality;
    fullTextStatus: PaperFullTextProcessingStatus;
    now?: Date;
  },
): Promise<PaperProcessingState> {
  const nowIso = now.toISOString();
  const rows = (await sqlClient`
    UPDATE paper_processing_state
    SET source_hash = ${sourceHash},
        evidence_quality = ${evidenceQuality},
        full_text_status = ${fullTextStatus},
        deterministic_status = 'succeeded',
        semantic_status = 'pending',
        digest_ready = FALSE,
        deterministic_attempt_count = 0,
        semantic_attempt_count = 0,
        deterministic_next_run_at = ${nowIso}::timestamptz,
        semantic_next_run_at = ${nowIso}::timestamptz,
        lease_token = NULL,
        lease_expires_at = NULL,
        deterministic_last_error = NULL,
        semantic_last_error = NULL,
        last_success_at = ${nowIso}::timestamptz,
        updated_at = ${nowIso}::timestamptz
    WHERE feed_item_id = ${feedItemId}
      AND (${leaseToken ?? null}::text IS NULL OR lease_token = ${leaseToken ?? null})
      AND (${expectedSourceHash ?? null}::text IS NULL OR source_hash = ${expectedSourceHash ?? null})
    RETURNING *
  `) as PaperProcessingState[];
  if (!rows[0]) {
    throw new Error(
      `No deterministic paper processing state updated for feed_item_id=${feedItemId}`,
    );
  }
  return toStateRow(rows[0]);
}

export async function markDeterministicProcessingDead(
  sqlClient: SqlClient,
  {
    feedItemId,
    leaseToken,
    error,
    fullTextStatus,
    attemptCount,
    now = new Date(),
  }: {
    feedItemId: number;
    leaseToken?: string | null;
    error: unknown;
    fullTextStatus?: PaperFullTextProcessingStatus | null;
    attemptCount?: number;
    now?: Date;
  },
): Promise<DeterministicFailureResult> {
  const nowIso = now.toISOString();
  const finalAttemptCount = attemptCount ?? PAPER_DETERMINISTIC_MAX_ATTEMPTS;
  const rows = (await sqlClient`
    UPDATE paper_processing_state
    SET deterministic_status = 'dead',
        digest_ready = FALSE,
        deterministic_attempt_count = ${finalAttemptCount},
        deterministic_next_run_at = ${nowIso}::timestamptz,
        full_text_status = COALESCE(${fullTextStatus ?? null}::text, full_text_status),
        deterministic_last_error = ${truncateError(error)},
        lease_token = NULL,
        lease_expires_at = NULL,
        last_failed_at = ${nowIso}::timestamptz,
        updated_at = ${nowIso}::timestamptz
    WHERE feed_item_id = ${feedItemId}
      AND (${leaseToken ?? null}::text IS NULL OR lease_token = ${leaseToken ?? null})
    RETURNING deterministic_attempt_count
  `) as Array<{ deterministic_attempt_count: number | string }>;
  if (!rows[0]) {
    throw new Error(
      `No deterministic paper processing state dead-lettered for feed_item_id=${feedItemId}`,
    );
  }
  return {
    feedItemId,
    status: "dead",
    attemptCount: toInteger(rows[0].deterministic_attempt_count),
    nextRunAt: null,
    dead: true,
  };
}

export async function markDeterministicProcessingFailed(
  sqlClient: SqlClient,
  {
    feedItemId,
    leaseToken,
    error,
    fullTextStatus,
    now = new Date(),
  }: {
    feedItemId: number;
    leaseToken?: string | null;
    error: unknown;
    fullTextStatus?: PaperFullTextProcessingStatus | null;
    now?: Date;
  },
): Promise<DeterministicFailureResult> {
  const currentRows = (await sqlClient`
    SELECT deterministic_attempt_count
    FROM paper_processing_state
    WHERE feed_item_id = ${feedItemId}
    LIMIT 1
  `) as Array<{ deterministic_attempt_count: number | string }>;
  const nextAttemptCount =
    toInteger(currentRows[0]?.deterministic_attempt_count ?? 0) + 1;

  if (nextAttemptCount >= PAPER_DETERMINISTIC_MAX_ATTEMPTS) {
    return markDeterministicProcessingDead(sqlClient, {
      feedItemId,
      leaseToken,
      error,
      fullTextStatus,
      attemptCount: nextAttemptCount,
      now,
    });
  }

  const nextRunAt = calculateRetryNextRunAt(nextAttemptCount, now);
  const nowIso = now.toISOString();
  const nextRunAtIso = nextRunAt?.toISOString() ?? nowIso;
  const rows = (await sqlClient`
    UPDATE paper_processing_state
    SET deterministic_status = 'failed',
        digest_ready = FALSE,
        deterministic_attempt_count = ${nextAttemptCount},
        deterministic_next_run_at = ${nextRunAtIso}::timestamptz,
        full_text_status = COALESCE(${fullTextStatus ?? null}::text, full_text_status),
        deterministic_last_error = ${truncateError(error)},
        lease_token = NULL,
        lease_expires_at = NULL,
        last_failed_at = ${nowIso}::timestamptz,
        updated_at = ${nowIso}::timestamptz
    WHERE feed_item_id = ${feedItemId}
      AND (${leaseToken ?? null}::text IS NULL OR lease_token = ${leaseToken ?? null})
    RETURNING deterministic_attempt_count
  `) as Array<{ deterministic_attempt_count: number | string }>;
  if (!rows[0]) {
    throw new Error(
      `No deterministic paper processing state failed for feed_item_id=${feedItemId}`,
    );
  }

  return {
    feedItemId,
    status: "failed",
    attemptCount: toInteger(rows[0].deterministic_attempt_count),
    nextRunAt,
    dead: false,
  };
}

export async function markSemanticProcessingSucceeded(
  sqlClient: SqlClient,
  {
    feedItemId,
    leaseToken,
    expectedSourceHash,
    now = new Date(),
  }: {
    feedItemId: number;
    leaseToken?: string | null;
    expectedSourceHash?: string | null;
    now?: Date;
  },
): Promise<PaperProcessingState> {
  const nowIso = now.toISOString();
  const currentRows = (await sqlClient`
    SELECT semantic_attempt_count
    FROM paper_processing_state
    WHERE feed_item_id = ${feedItemId}
    LIMIT 1
  `) as Array<{ semantic_attempt_count: number | string }>;
  const previousAttemptCount = toInteger(
    currentRows[0]?.semantic_attempt_count ?? 0,
  );
  const rows = (await sqlClient`
    UPDATE paper_processing_state
    SET semantic_status = 'succeeded',
        digest_ready = TRUE,
        semantic_attempt_count = 0,
        semantic_next_run_at = ${nowIso}::timestamptz,
        lease_token = NULL,
        lease_expires_at = NULL,
        semantic_last_error = NULL,
        last_success_at = ${nowIso}::timestamptz,
        updated_at = ${nowIso}::timestamptz
    WHERE feed_item_id = ${feedItemId}
      AND (${leaseToken ?? null}::text IS NULL OR lease_token = ${leaseToken ?? null})
      AND (${expectedSourceHash ?? null}::text IS NULL OR source_hash = ${expectedSourceHash ?? null})
      AND deterministic_status = 'succeeded'
    RETURNING *
  `) as PaperProcessingState[];
  if (!rows[0]) {
    throw new Error(
      `No semantic paper processing state updated for feed_item_id=${feedItemId}`,
    );
  }
  const succeeded = toStateRow(rows[0]);
  try {
    await finalizeCompletedPendingHotSetPromotions(sqlClient, [feedItemId], now);
    return succeeded;
  } catch (error) {
    const retryState = await rescheduleSemanticFinalizationFailure(
      sqlClient,
      feedItemId,
      error,
      now,
      previousAttemptCount,
    );
    if (retryState) {
      return retryState;
    }
    throw error;
  }
}

export async function markSemanticEmbeddingPending(
  sqlClient: SqlClient,
  {
    feedItemId,
    leaseToken,
    expectedSourceHash,
    reason = "semantic embeddings pending",
    now = new Date(),
  }: {
    feedItemId: number;
    leaseToken?: string | null;
    expectedSourceHash?: string | null;
    reason?: string;
    now?: Date;
  },
): Promise<PaperProcessingState> {
  const nowIso = now.toISOString();
  const rows = (await sqlClient`
    UPDATE paper_processing_state
    SET semantic_status = 'pending',
        digest_ready = FALSE,
        semantic_next_run_at = ${nowIso}::timestamptz,
        semantic_last_error = ${truncateError(reason)},
        lease_token = NULL,
        lease_expires_at = NULL,
        updated_at = ${nowIso}::timestamptz
    WHERE feed_item_id = ${feedItemId}
      AND (${leaseToken ?? null}::text IS NULL OR lease_token = ${leaseToken ?? null})
      AND (${expectedSourceHash ?? null}::text IS NULL OR source_hash = ${expectedSourceHash ?? null})
      AND deterministic_status = 'succeeded'
    RETURNING *
  `) as PaperProcessingState[];
  if (!rows[0]) {
    throw new Error(
      `No semantic paper processing state parked for feed_item_id=${feedItemId}`,
    );
  }
  return toStateRow(rows[0]);
}

export async function markSemanticProcessingDead(
  sqlClient: SqlClient,
  {
    feedItemId,
    leaseToken,
    error,
    attemptCount,
    now = new Date(),
  }: {
    feedItemId: number;
    leaseToken?: string | null;
    error: unknown;
    attemptCount?: number;
    now?: Date;
  },
): Promise<SemanticFailureResult> {
  const nowIso = now.toISOString();
  const finalAttemptCount = attemptCount ?? PAPER_SEMANTIC_MAX_ATTEMPTS;
  const rows = (await sqlClient`
    UPDATE paper_processing_state
    SET semantic_status = 'dead',
        digest_ready = FALSE,
        semantic_attempt_count = ${finalAttemptCount},
        semantic_next_run_at = ${nowIso}::timestamptz,
        semantic_last_error = ${truncateError(error)},
        lease_token = NULL,
        lease_expires_at = NULL,
        last_failed_at = ${nowIso}::timestamptz,
        updated_at = ${nowIso}::timestamptz
    WHERE feed_item_id = ${feedItemId}
      AND (${leaseToken ?? null}::text IS NULL OR lease_token = ${leaseToken ?? null})
    RETURNING semantic_attempt_count
  `) as Array<{ semantic_attempt_count: number | string }>;
  if (!rows[0]) {
    throw new Error(
      `No semantic paper processing state dead-lettered for feed_item_id=${feedItemId}`,
    );
  }
  return {
    feedItemId,
    status: "dead",
    attemptCount: toInteger(rows[0].semantic_attempt_count),
    nextRunAt: null,
    dead: true,
  };
}

export async function markSemanticProcessingFailed(
  sqlClient: SqlClient,
  {
    feedItemId,
    leaseToken,
    error,
    now = new Date(),
  }: {
    feedItemId: number;
    leaseToken?: string | null;
    error: unknown;
    now?: Date;
  },
): Promise<SemanticFailureResult> {
  const currentRows = (await sqlClient`
    SELECT semantic_attempt_count
    FROM paper_processing_state
    WHERE feed_item_id = ${feedItemId}
    LIMIT 1
  `) as Array<{ semantic_attempt_count: number | string }>;
  const nextAttemptCount =
    toInteger(currentRows[0]?.semantic_attempt_count ?? 0) + 1;

  if (nextAttemptCount >= PAPER_SEMANTIC_MAX_ATTEMPTS) {
    return markSemanticProcessingDead(sqlClient, {
      feedItemId,
      leaseToken,
      error,
      attemptCount: nextAttemptCount,
      now,
    });
  }

  const nextRunAt = calculateRetryNextRunAt(nextAttemptCount, now);
  const nowIso = now.toISOString();
  const nextRunAtIso = nextRunAt?.toISOString() ?? nowIso;
  const rows = (await sqlClient`
    UPDATE paper_processing_state
    SET semantic_status = 'failed',
        digest_ready = FALSE,
        semantic_attempt_count = ${nextAttemptCount},
        semantic_next_run_at = ${nextRunAtIso}::timestamptz,
        semantic_last_error = ${truncateError(error)},
        lease_token = NULL,
        lease_expires_at = NULL,
        last_failed_at = ${nowIso}::timestamptz,
        updated_at = ${nowIso}::timestamptz
    WHERE feed_item_id = ${feedItemId}
      AND (${leaseToken ?? null}::text IS NULL OR lease_token = ${leaseToken ?? null})
    RETURNING semantic_attempt_count
  `) as Array<{ semantic_attempt_count: number | string }>;
  if (!rows[0]) {
    throw new Error(
      `No semantic paper processing state failed for feed_item_id=${feedItemId}`,
    );
  }

  return {
    feedItemId,
    status: "failed",
    attemptCount: toInteger(rows[0].semantic_attempt_count),
    nextRunAt,
    dead: false,
  };
}
