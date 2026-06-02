import Anthropic from "@anthropic-ai/sdk";
import type {
  Message,
  MessageCreateParamsNonStreaming,
  TextBlock,
} from "@anthropic-ai/sdk/resources/messages";
import { sql } from "@/lib/db";
import type { FeedItem, FeedItemSourceType } from "@/lib/schema";
import {
  DIGEST_INTRO,
  SUMMARIZE_TWEETS,
  SUMMARIZE_PODCAST,
  SUMMARIZE_NEWSLETTER,
  SUMMARIZE_PAPERS,
} from "@/lib/prompts";

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const MIN_DIGEST_OUTPUT_TOKENS = 4_096;
const MAX_DIGEST_OUTPUT_TOKENS = 16_384;
const DIGEST_OUTPUT_TOKEN_OVERHEAD = 2_048;
const DIGEST_OUTPUT_TOKENS_PER_SOURCE: Record<FeedItemSourceType, number> = {
  tweet: 180,
  podcast: 450,
  newsletter: 450,
  paper: 760,
};
const MAX_DIGEST_PROFILE_CHARS = 1_800;
const MAX_DIGEST_EVIDENCE_CARDS_PER_PAPER = 8;
const MAX_DIGEST_EVIDENCE_CLAIM_CHARS = 420;
const MAX_DIGEST_EVIDENCE_ARRAY_VALUES = 8;
const MAX_SKIPPED_PAPER_IDS = 50;

export interface DigestPaperEvidenceCard {
  claim: string;
  claim_type: string;
  section_path: string[];
  numbers: string[];
  confidence: number | null;
}

export interface DigestSkippedPaperRow {
  id: number;
  deterministicStatus: string;
  semanticStatus: string;
}

export interface DigestSkippedPapers {
  total: number;
  ids: number[];
  rows: DigestSkippedPaperRow[];
  countsByDeterministicStatus: Record<string, number>;
  countsBySemanticStatus: Record<string, number>;
  pendingIds: number[];
  deadIds: number[];
}

export interface DigestResult {
  content: string;
  tweetCount: number;
  podcastCount: number;
  newsletterCount: number;
  paperCount: number;
  itemCount: number;
  sourceItemIds: number[];
  model: string;
  skippedPapers: DigestSkippedPapers;
}

export interface DigestGenerationResult {
  digest: DigestResult | null;
  skippedPapers: DigestSkippedPapers;
}

const PROMPT_MAP: Record<FeedItemSourceType, string> = {
  tweet: SUMMARIZE_TWEETS,
  podcast: SUMMARIZE_PODCAST,
  newsletter: SUMMARIZE_NEWSLETTER,
  paper: SUMMARIZE_PAPERS,
};

const GROUP_KEY_MAP: Record<FeedItemSourceType, string> = {
  tweet: "tweets",
  podcast: "podcasts",
  newsletter: "newsletters",
  paper: "papers",
};
const DIGEST_SOURCE_ORDER: FeedItemSourceType[] = [
  "paper",
  "tweet",
  "podcast",
  "newsletter",
];

export function resolveDigestModel(
  requestedModel?: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const explicitModel = requestedModel?.trim();
  if (explicitModel) {
    return explicitModel;
  }

  const configuredModel = env.DIGEST_MODEL?.trim();
  return configuredModel || DEFAULT_MODEL;
}

type DigestFeedItem = FeedItem & {
  paper_profile_text?: string | null;
  paper_evidence_cards?: unknown;
};

type AnthropicDigestResponse = Message;

type DigestPayloadItem = Omit<
  DigestFeedItem,
  "paper_profile_text" | "paper_evidence_cards"
> & {
  paper_reader_profile?: { profile_text: string } | null;
  paper_evidence_cards?: DigestPaperEvidenceCard[];
};

interface SkippedPaperQueryRow {
  id: number | string;
  deterministic_status: string | null;
  semantic_status: string | null;
  total_count: number | string | null;
}

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

function truncateText(value: unknown, maxChars: number): string {
  const normalized = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd();
}

function compactStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const normalized = truncateText(entry, 80);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
    if (result.length >= MAX_DIGEST_EVIDENCE_ARRAY_VALUES) {
      break;
    }
  }
  return result;
}

function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function normalizeDigestPaperEvidenceCards(value: unknown): DigestPaperEvidenceCard[] {
  return parseJsonArray(value)
    .slice(0, MAX_DIGEST_EVIDENCE_CARDS_PER_PAPER)
    .map((entry) => {
      const record = entry && typeof entry === "object"
        ? (entry as Record<string, unknown>)
        : {};
      const confidence =
        typeof record.confidence === "number" && Number.isFinite(record.confidence)
          ? record.confidence
          : null;
      return {
        claim: truncateText(record.claim, MAX_DIGEST_EVIDENCE_CLAIM_CHARS),
        claim_type: truncateText(record.claim_type, 40),
        section_path: compactStringArray(record.section_path),
        numbers: compactStringArray(record.numbers),
        confidence,
      };
    })
    .filter((card) => card.claim);
}

function toDigestPayloadItem(item: DigestFeedItem): DigestPayloadItem {
  const { paper_profile_text, paper_evidence_cards, ...base } = item;
  if (base.source_type !== "paper") {
    return base;
  }

  const profileText = truncateText(paper_profile_text, MAX_DIGEST_PROFILE_CHARS);
  return {
    ...base,
    paper_reader_profile: profileText ? { profile_text: profileText } : null,
    paper_evidence_cards: normalizeDigestPaperEvidenceCards(paper_evidence_cards),
  };
}

function summarizeSkippedPapers(rows: SkippedPaperQueryRow[]): DigestSkippedPapers {
  const total = toInteger(rows[0]?.total_count ?? rows.length);
  const normalizedRows = rows.map((row) => ({
    id: toInteger(row.id),
    deterministicStatus: row.deterministic_status ?? "missing",
    semanticStatus: row.semantic_status ?? "missing",
  }));
  const countsByDeterministicStatus: Record<string, number> = {};
  const countsBySemanticStatus: Record<string, number> = {};
  for (const row of normalizedRows) {
    countsByDeterministicStatus[row.deterministicStatus] =
      (countsByDeterministicStatus[row.deterministicStatus] ?? 0) + 1;
    countsBySemanticStatus[row.semanticStatus] =
      (countsBySemanticStatus[row.semanticStatus] ?? 0) + 1;
  }

  return {
    total,
    ids: normalizedRows.map((row) => row.id),
    rows: normalizedRows,
    countsByDeterministicStatus,
    countsBySemanticStatus,
    pendingIds: normalizedRows
      .filter((row) => {
        if (row.deterministicStatus === "dead" || row.semanticStatus === "dead") {
          return false;
        }
        if (
          ["missing", "pending", "running", "failed", "stale"].includes(
            row.deterministicStatus,
          )
        ) {
          return true;
        }
        return (
          row.deterministicStatus === "succeeded" &&
          ["missing", "pending", "running", "failed", "stale", "skipped"].includes(
            row.semanticStatus,
          )
        );
      })
      .map((row) => row.id),
    deadIds: normalizedRows
      .filter((row) =>
        row.deterministicStatus === "dead" || row.semanticStatus === "dead",
      )
      .map((row) => row.id),
  };
}

function emptySkippedPapers(): DigestSkippedPapers {
  return {
    total: 0,
    ids: [],
    rows: [],
    countsByDeterministicStatus: {},
    countsBySemanticStatus: {},
    pendingIds: [],
    deadIds: [],
  };
}

function digestOutputTokenBudget(
  grouped: Partial<Record<FeedItemSourceType, DigestFeedItem[]>>,
): number {
  const estimated = (Object.entries(grouped) as [FeedItemSourceType, DigestFeedItem[]][])
    .reduce((total, [sourceType, items]) => (
      total + items.length * DIGEST_OUTPUT_TOKENS_PER_SOURCE[sourceType]
    ), DIGEST_OUTPUT_TOKEN_OVERHEAD);

  return Math.min(
    MAX_DIGEST_OUTPUT_TOKENS,
    Math.max(MIN_DIGEST_OUTPUT_TOKENS, estimated),
  );
}

async function createDigestMessage({
  anthropic,
  model,
  maxTokens,
  systemPrompt,
  userMessage,
}: {
  anthropic: Anthropic;
  model: string;
  maxTokens: number;
  systemPrompt: string;
  userMessage: string;
}): Promise<AnthropicDigestResponse> {
  const body: MessageCreateParamsNonStreaming = {
    model,
    max_tokens: maxTokens,
    stream: false,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  };

  return anthropic.messages.create(body);
}

function extractDigestText(response: AnthropicDigestResponse): string {
  return response.content
    .filter((block): block is TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export async function fetchSkippedDigestPapers(force?: boolean): Promise<DigestSkippedPapers> {
  const rows = force
    ? ((await sql`
        SELECT
          fi.id,
          COALESCE(pps.deterministic_status, 'missing') AS deterministic_status,
          COALESCE(pps.semantic_status, 'missing') AS semantic_status,
          COUNT(*) OVER() AS total_count
        FROM feed_items fi
        LEFT JOIN paper_processing_state pps ON pps.feed_item_id = fi.id
        WHERE fi.source_type = 'paper'
          AND fi.fetched_at > NOW() - INTERVAL '24 hours'
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
                ELSE NOW() BETWEEN
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
            pps.feed_item_id IS NULL
            OR COALESCE(pps.digest_ready, FALSE) = FALSE
            OR pps.deterministic_status <> 'succeeded'
            OR pps.semantic_status <> 'succeeded'
          )
        ORDER BY fi.published_at DESC NULLS LAST, fi.id DESC
        LIMIT ${MAX_SKIPPED_PAPER_IDS}
      `) as SkippedPaperQueryRow[])
    : ((await sql`
        SELECT
          fi.id,
          COALESCE(pps.deterministic_status, 'missing') AS deterministic_status,
          COALESCE(pps.semantic_status, 'missing') AS semantic_status,
          COUNT(*) OVER() AS total_count
        FROM feed_items fi
        LEFT JOIN paper_processing_state pps ON pps.feed_item_id = fi.id
        WHERE fi.source_type = 'paper'
          AND fi.fetched_at > NOW() - INTERVAL '24 hours'
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
                ELSE NOW() BETWEEN
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
            pps.feed_item_id IS NULL
            OR COALESCE(pps.digest_ready, FALSE) = FALSE
            OR pps.deterministic_status <> 'succeeded'
            OR pps.semantic_status <> 'succeeded'
          )
          AND fi.id NOT IN (
            SELECT UNNEST(source_item_ids)
            FROM digests
            WHERE generated_at > NOW() - INTERVAL '72 hours'
          )
        ORDER BY fi.published_at DESC NULLS LAST, fi.id DESC
        LIMIT ${MAX_SKIPPED_PAPER_IDS}
      `) as SkippedPaperQueryRow[]);

  return summarizeSkippedPapers(rows);
}

async function generateDigestInternal(
  model?: string,
  force?: boolean,
  includeSkippedPapers = false,
): Promise<DigestGenerationResult> {
  const skippedPapers = includeSkippedPapers
    ? await fetchSkippedDigestPapers(force)
    : emptySkippedPapers();
  // Query recent feed items with different time windows.
  // Unless force=true, exclude items already included in a previous digest
  // (scoped to recent digests for performance).
  const recentShort = force
    ? ((await sql`
        SELECT
          fi.id,
          fi.source_type,
          fi.title,
          fi.content,
          fi.url,
          fi.author_name,
          fi.author_handle,
          fi.published_at,
          fi.tweet_meta,
          fi.paper_meta,
          prp.profile_text AS paper_profile_text,
          paper_cards.cards AS paper_evidence_cards
        FROM feed_items fi
        LEFT JOIN paper_processing_state pps ON pps.feed_item_id = fi.id
        LEFT JOIN paper_reader_profiles prp ON prp.feed_item_id = fi.id
        LEFT JOIN LATERAL (
          SELECT COALESCE(
            jsonb_agg(
              jsonb_build_object(
                'claim', cards.claim,
                'claim_type', cards.claim_type,
                'section_path', cards.section_path,
                'numbers', cards.numbers,
                'confidence', cards.confidence
              )
            ),
            '[]'::jsonb
          ) AS cards
          FROM (
            SELECT claim, claim_type, section_path, numbers, confidence, id
            FROM paper_evidence_cards
            WHERE feed_item_id = fi.id
            ORDER BY confidence DESC, id ASC
            LIMIT ${MAX_DIGEST_EVIDENCE_CARDS_PER_PAPER}
          ) cards
        ) paper_cards ON fi.source_type = 'paper'
        WHERE fi.source_type IN ('tweet', 'paper')
          AND fi.fetched_at > NOW() - INTERVAL '24 hours'
          AND (
            fi.source_type <> 'paper'
            OR (
              pps.digest_ready = TRUE
              AND pps.deterministic_status = 'succeeded'
              AND pps.semantic_status = 'succeeded'
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
                    ELSE NOW() BETWEEN
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
            )
          )
        ORDER BY fi.source_type, fi.published_at DESC
      `) as DigestFeedItem[])
    : ((await sql`
        SELECT
          fi.id,
          fi.source_type,
          fi.title,
          fi.content,
          fi.url,
          fi.author_name,
          fi.author_handle,
          fi.published_at,
          fi.tweet_meta,
          fi.paper_meta,
          prp.profile_text AS paper_profile_text,
          paper_cards.cards AS paper_evidence_cards
        FROM feed_items fi
        LEFT JOIN paper_processing_state pps ON pps.feed_item_id = fi.id
        LEFT JOIN paper_reader_profiles prp ON prp.feed_item_id = fi.id
        LEFT JOIN LATERAL (
          SELECT COALESCE(
            jsonb_agg(
              jsonb_build_object(
                'claim', cards.claim,
                'claim_type', cards.claim_type,
                'section_path', cards.section_path,
                'numbers', cards.numbers,
                'confidence', cards.confidence
              )
            ),
            '[]'::jsonb
          ) AS cards
          FROM (
            SELECT claim, claim_type, section_path, numbers, confidence, id
            FROM paper_evidence_cards
            WHERE feed_item_id = fi.id
            ORDER BY confidence DESC, id ASC
            LIMIT ${MAX_DIGEST_EVIDENCE_CARDS_PER_PAPER}
          ) cards
        ) paper_cards ON fi.source_type = 'paper'
        WHERE fi.source_type IN ('tweet', 'paper')
          AND fi.fetched_at > NOW() - INTERVAL '24 hours'
          AND (
            fi.source_type <> 'paper'
            OR (
              pps.digest_ready = TRUE
              AND pps.deterministic_status = 'succeeded'
              AND pps.semantic_status = 'succeeded'
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
                    ELSE NOW() BETWEEN
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
            )
          )
          AND fi.id NOT IN (
            SELECT UNNEST(source_item_ids)
            FROM digests
            WHERE generated_at > NOW() - INTERVAL '72 hours'
          )
        ORDER BY fi.source_type, fi.published_at DESC
      `) as DigestFeedItem[]);

  const recentLong = force
    ? ((await sql`
        SELECT id, source_type, title, content, url,
               author_name, author_handle, published_at,
               tweet_meta, paper_meta
        FROM feed_items
        WHERE source_type IN ('podcast', 'newsletter')
        AND fetched_at > NOW() - INTERVAL '72 hours'
        ORDER BY source_type, published_at DESC
      `) as FeedItem[])
    : ((await sql`
        SELECT id, source_type, title, content, url,
               author_name, author_handle, published_at,
               tweet_meta, paper_meta
        FROM feed_items
        WHERE source_type IN ('podcast', 'newsletter')
        AND fetched_at > NOW() - INTERVAL '72 hours'
        AND id NOT IN (SELECT UNNEST(source_item_ids) FROM digests WHERE generated_at > NOW() - INTERVAL '72 hours')
        ORDER BY source_type, published_at DESC
      `) as FeedItem[]);

  const allItems = [...recentShort, ...recentLong];

  if (allItems.length === 0) {
    return { digest: null, skippedPapers };
  }

  // Group items by source type
  const grouped: Partial<Record<FeedItemSourceType, DigestFeedItem[]>> = {};
  for (const item of allItems) {
    if (!grouped[item.source_type]) {
      grouped[item.source_type] = [];
    }
    grouped[item.source_type]!.push(item);
  }

  // Build system prompt: DIGEST_INTRO + only relevant SUMMARIZE_* prompts
  const promptParts = [DIGEST_INTRO];
  for (const sourceType of DIGEST_SOURCE_ORDER) {
    if (!grouped[sourceType]?.length) {
      continue;
    }
    promptParts.push(PROMPT_MAP[sourceType]);
  }
  const systemPrompt = promptParts.join("\n\n---\n\n");

  // Build user message: JSON grouped by source type
  const userPayload: Record<string, DigestPayloadItem[]> = {};
  for (const sourceType of DIGEST_SOURCE_ORDER) {
    const items = grouped[sourceType];
    if (!items?.length) {
      continue;
    }
    userPayload[GROUP_KEY_MAP[sourceType]] = items.map(toDigestPayloadItem);
  }
  const userMessage = JSON.stringify(userPayload);

  // Call Claude API
  const selectedModel = resolveDigestModel(model);
  const anthropic = new Anthropic();
  const maxTokens = digestOutputTokenBudget(grouped);
  let response = await createDigestMessage({
    anthropic,
    model: selectedModel,
    maxTokens,
    systemPrompt,
    userMessage,
  });

  if (response.stop_reason === "max_tokens" && maxTokens < MAX_DIGEST_OUTPUT_TOKENS) {
    response = await createDigestMessage({
      anthropic,
      model: selectedModel,
      maxTokens: MAX_DIGEST_OUTPUT_TOKENS,
      systemPrompt,
      userMessage,
    });
  }

  if (response.stop_reason === "max_tokens") {
    throw new Error(
      `Digest generation reached Claude's output token limit (${MAX_DIGEST_OUTPUT_TOKENS}); refusing to store a truncated digest.`,
    );
  }

  const content = extractDigestText(response);

  // Count items per source type
  const tweetCount = grouped.tweet?.length ?? 0;
  const podcastCount = grouped.podcast?.length ?? 0;
  const newsletterCount = grouped.newsletter?.length ?? 0;
  const paperCount = grouped.paper?.length ?? 0;

  return {
    digest: {
      content,
      tweetCount,
      podcastCount,
      newsletterCount,
      paperCount,
      itemCount: allItems.length,
      sourceItemIds: allItems.map((item) => item.id),
      model: selectedModel,
      skippedPapers,
    },
    skippedPapers,
  };
}

export async function generateDigest(
  model?: string,
  force?: boolean,
): Promise<DigestResult | null> {
  const result = await generateDigestInternal(model, force, false);
  return result.digest;
}

export async function generateDigestWithMetadata(
  model?: string,
  force?: boolean,
): Promise<DigestGenerationResult> {
  return generateDigestInternal(model, force, true);
}
