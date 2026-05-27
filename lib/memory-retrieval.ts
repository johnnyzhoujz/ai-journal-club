import Anthropic from "@anthropic-ai/sdk";

import { sql } from "@/lib/db";
import {
  embedMemoryText,
  formatPgVectorLiteral,
  isMemoryVectorEnabled,
} from "@/lib/memory-embeddings";
import {
  buildEvidenceClaimProfile,
  scoreEvidenceChunkForClaim,
  type EvidenceClaimProfile,
} from "@/lib/memory-evidence-rerank";
import {
  extractPaperEvidenceClaimTerms,
  isReferenceLikePaperEvidenceText,
  verifyPaperEvidenceChunks,
} from "@/lib/paper-evidence-verifier";
import {
  isPaperEvidenceLayerEnabled,
  queryPaperEvidenceLayerRows,
} from "@/lib/paper-evidence-layer";
import type {
  PaperEvidenceClaimType,
  PaperEvidenceLayerCorpusScope,
  PaperEvidenceLayerSearchRow,
  PaperEvidenceSpanOrigin,
  PaperEvidenceSpanType,
  PaperSectionType,
} from "@/lib/paper-evidence-layer";
import type {
  FeedItemSourceType,
  GetMemoryChunkToolResult,
  MemorySearchChunkHit,
  MemorySearchMode,
  MemorySearchScope,
  MemorySearchSource,
  PaperCorpusScope,
  PaperEvidenceDebugChunk,
  PaperEvidenceHitMetadata,
  SearchMemoryToolResult,
} from "@/lib/schema";

export const DEFAULT_MEMORY_SEARCH_LIMIT = 4;
export const MAX_MEMORY_SEARCH_LIMIT = 20;
export const MAX_MEMORY_SEARCH_SNIPPET_CHARS = 500;
export const MAX_PAPER_EVIDENCE_SNIPPET_CHARS = 1_000;
export const MAX_MEMORY_ITEM_EXCERPT_CHARS = 1_500;
export const MAX_PAPER_EVIDENCE_DEBUG_TEXT_CHARS = 4_000;
export const DEFAULT_MEMORY_RETRIEVAL_CANDIDATE_LIMIT = 30;
export const DEFAULT_MEMORY_RERANK_MODEL = "claude-haiku-4-5-20251001";
export const DEFAULT_MEMORY_RERANK_MIN_RELEVANCE = 2;

const MEMORY_SNIPPET_START = "__memory_snippet_start__";
const MEMORY_SNIPPET_END = "__memory_snippet_end__";
const MEMORY_SNIPPET_OPTIONS = [
  "MaxFragments=2",
  "MaxWords=36",
  "MinWords=12",
  `StartSel=${MEMORY_SNIPPET_START}`,
  `StopSel=${MEMORY_SNIPPET_END}`,
].join(", ");
const HYBRID_MEMORY_CANDIDATE_LIMIT = 50;
const HYBRID_MEMORY_RANK_CONSTANT = 60;
const HYBRID_MEMORY_FTS_WEIGHT = 1.5;
const HYBRID_MEMORY_VEC_WEIGHT = 1.0;
const readPaperEvidenceSectionBonus = (
  envKey: string,
  defaultValue: number,
): number => {
  const rawValue = process.env[envKey];
  if (rawValue == null || rawValue.trim() === "") {
    return defaultValue;
  }
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) {
    throw new Error(
      `${envKey} must be a finite number for paper evidence section bonus`,
    );
  }
  return parsed;
};
export const PAPER_EVIDENCE_SECTION_BONUS = {
  result: readPaperEvidenceSectionBonus("PAPER_EVIDENCE_BONUS_RESULT", 0.04),
  method: readPaperEvidenceSectionBonus("PAPER_EVIDENCE_BONUS_METHOD", 0.03),
  limitation: readPaperEvidenceSectionBonus(
    "PAPER_EVIDENCE_BONUS_LIMITATION",
    0.02,
  ),
  abstract: readPaperEvidenceSectionBonus("PAPER_EVIDENCE_BONUS_ABSTRACT", 0.01),
  other: readPaperEvidenceSectionBonus("PAPER_EVIDENCE_BONUS_OTHER", 0),
} as const;
const HYBRID_MEMORY_MAX_VECTOR_ONLY_WITH_FTS = 1;
const HYBRID_MEMORY_VECTOR_ONLY_WITH_FTS_MAX_DISTANCE = 0.7;
const HYBRID_MEMORY_VECTOR_ONLY_MAX_DISTANCE = 0.72;
const MEMORY_LEXICAL_FALLBACK_MIN_TERMS = 6;
const MEMORY_LEXICAL_FALLBACK_WEIGHT = 0.35;
const MEMORY_QUERY_EXPANSION_MIN_TERMS = 6;
const MEMORY_EXPANSION_MAX_QUERIES = 3;
const MEMORY_LEXICAL_ALIAS_MAX_QUERIES = 3;
const MEMORY_PARENT_EVIDENCE_CHUNKS_PER_ITEM = 2;
const PAPER_EVIDENCE_CANDIDATE_LIMIT = 3;
const PAPER_EVIDENCE_LOCAL_CHUNKS_PER_ITEM = 96;
const PAPER_EVIDENCE_LOCAL_SNIPPETS_PER_ITEM = 4;
const PAPER_EVIDENCE_GRAPH_QUERY_LIMIT = 12;
const PAPER_EVIDENCE_FAST_GRAPH_MIN_SCORE = 10;
const HYBRID_PAPER_EVIDENCE_CANDIDATE_LIMIT = 50;
const HYBRID_PAPER_EVIDENCE_MAX_SEARCH_QUERY_PARTS = 28;
const HYBRID_PAPER_EVIDENCE_MAX_SEARCH_QUERY_CHARS = 1_500;
const MEMORY_PARENT_CHUNK_WEIGHT = 1.0;
const MEMORY_PARENT_FEED_ITEM_WEIGHT = 1.35;
const MEMORY_PARENT_TITLE_ONLY_PODCAST_SEMANTIC_FACTOR = 0.55;
const MEMORY_PARENT_BROAD_CONTAINER_SEMANTIC_FACTOR = 0.7;

const SIGNIFICANT_EXACT_TERM_STOPWORDS = new Set([
  "about",
  "across",
  "after",
  "again",
  "agents",
  "because",
  "before",
  "being",
  "between",
  "could",
  "doing",
  "does",
  "from",
  "have",
  "into",
  "more",
  "should",
  "than",
  "that",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "what",
  "when",
  "where",
  "which",
  "while",
  "with",
  "without",
  "would",
]);
const SIGNIFICANT_EXACT_SHORT_TERMS = new Set([
  "api",
  "cto",
  "gpt",
  "mcp",
  "sap",
  "ui",
  "vla",
]);

export const SUPPORTED_MEMORY_SEARCH_SCOPES = ["all", "chunk"] as const;
export const SUPPORTED_MEMORY_SEARCH_MODES = [
  "discovery",
  "evidence",
] as const;
export const VALID_MEMORY_SEARCH_SOURCES: readonly MemorySearchSource[] = [
  "all",
  "tweet",
  "podcast",
  "newsletter",
  "paper",
];
export const VALID_PAPER_CORPUS_SCOPES: readonly PaperCorpusScope[] = [
  "default",
  "latest",
  "archive",
  "all",
];

export interface SearchMemoryForToolParams {
  query: string;
  scope?: Extract<MemorySearchScope, "all" | "chunk">;
  source?: MemorySearchSource;
  mode?: MemorySearchMode;
  paperCorpusScope?: PaperCorpusScope;
  feedItemIds?: number[];
  after?: string | null;
  before?: string | null;
  limit?: number;
  debug?: boolean;
}

export interface GetMemoryItemForToolParams {
  memoryKind: "chunk";
  memoryId: number;
}

export interface MemorySearchChunkRow {
  id: number;
  feed_item_id: number;
  chunk_index?: number | null;
  source_type: FeedItemSourceType;
  title: string | null;
  author_name: string;
  published_at: string | null;
  url: string;
  snippet: string | null;
  text?: string | null;
  entity_labels: string[] | null;
  fts_rank?: number | null;
  vec_rank?: number | null;
  vec_distance?: number | string | null;
  rrf_score?: number | string | null;
  rerank_score?: number | null;
  rerank_model?: string | null;
  expansion_query?: string | null;
  paper_evidence?: PaperEvidenceHitMetadata;
}

export type MemoryQueryIntent = "metadata" | "attribution" | "semantic";

export interface MemoryFeedItemCandidateRow {
  feed_item_id: number;
  source_type: FeedItemSourceType;
  title: string | null;
  author_name: string;
  published_at: string | null;
  url: string;
  item_rank?: number | string | null;
  item_score?: number | string | null;
  exact_token_matches?: number | string | null;
  exact_token_count?: number | string | null;
  high_signal_token_matches?: number | string | null;
  high_signal_token_count?: number | string | null;
  title_match?: boolean | null;
  content_match?: boolean | null;
}

interface MemoryChunkDetailRow {
  id: number;
  feed_item_id: number;
  source_type: FeedItemSourceType;
  title: string | null;
  author_name: string;
  published_at: string | null;
  url: string;
  text: string;
  entity_labels: string[] | null;
}

export interface HybridPaperEvidenceQueryArgs {
  feedItemIds: number[];
  query: string;
  queryEmbedding: number[];
  paperCorpusScope: PaperEvidenceLayerCorpusScope;
  after: string | null;
  before: string | null;
  limitPerItem: number;
  queryFacets?: string[];
  exactEvidencePhrases?: string[];
}

interface StoredHybridPaperEvidenceLayerRow {
  id: number | string;
  feed_item_id: number | string;
  corpus_tier: string | null;
  chunk_index: number | string | null;
  title: string | null;
  author_name: string;
  published_at: string | null;
  url: string;
  span_id: number | string;
  card_id: number | string | null;
  section_path: string[] | null;
  section_type: PaperSectionType | null;
  span_type: PaperEvidenceSpanType;
  origin: PaperEvidenceSpanOrigin;
  claim_type: PaperEvidenceClaimType | null;
  snippet: string;
  text: string;
  entities: string[] | null;
  methods: string[] | null;
  datasets: string[] | null;
  metrics: string[] | null;
  numbers: string[] | null;
  aliases: string[] | null;
  fts_rank: number | string | null;
  vec_rank: number | string | null;
  vec_distance: number | string | null;
  rrf_score: number | string | null;
  evidence_score: number | string | null;
}

function normalizePlainText(value: string): string {
  return value
    .replaceAll(MEMORY_SNIPPET_START, "")
    .replaceAll(MEMORY_SNIPPET_END, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/[`*_>#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function classifyMemoryQueryIntent(query: string): MemoryQueryIntent {
  const normalized = ` ${normalizePlainText(query).toLowerCase()} `;

  if (
    /\bwho\s+(said|says|argued|claimed|posted|wrote|thinks?)\b/.test(
      normalized,
    ) ||
    /\bwhat\s+did\s+.+\s+(say|think|claim|argue|post|write)\b/.test(
      normalized,
    ) ||
    /\b(opinion|opinions|take|takes)\s+(on|about)\b/.test(normalized)
  ) {
    return "attribution";
  }

  if (
    /\b(podcast|episode|title|source|author|host|guest|interview)\b/.test(
      normalized,
    ) ||
    /\b(ceo|cto|founder|cofounder|president|role)\b/.test(normalized)
  ) {
    return "metadata";
  }

  return "semantic";
}

export function extractSignificantExactTerms(query: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  const matches = query.match(/[A-Za-z0-9][A-Za-z0-9.+#_-]*/g) ?? [];

  for (const raw of matches) {
    const normalized = raw
      .toLowerCase()
      .replace(/^[^a-z0-9]+|[^a-z0-9.+#_-]+$/g, "")
      .replace(/[_]+/g, "-");
    const compact = normalized.replace(/[^a-z0-9]/g, "");
    const isUppercaseToken =
      /^[A-Z0-9.+#_-]{2,}$/.test(raw) && /[A-Z]/.test(raw);
    const isSignificant =
      normalized.length >= 4 ||
      SIGNIFICANT_EXACT_SHORT_TERMS.has(normalized) ||
      (isUppercaseToken && compact.length >= 2 && !["ai", "ui"].includes(normalized));

    if (
      !normalized ||
      !isSignificant ||
      SIGNIFICANT_EXACT_TERM_STOPWORDS.has(normalized) ||
      seen.has(normalized)
    ) {
      continue;
    }

    seen.add(normalized);
    terms.push(normalized);

    for (const part of normalized.split(/[.+#-]+/)) {
      if (
        part &&
        part !== normalized &&
        (part.length >= 4 || SIGNIFICANT_EXACT_SHORT_TERMS.has(part)) &&
        !SIGNIFICANT_EXACT_TERM_STOPWORDS.has(part) &&
        !seen.has(part)
      ) {
        seen.add(part);
        terms.push(part);
      }
    }

    if (terms.length >= 12) {
      break;
    }
  }

  return terms.slice(0, 12);
}

export function extractHighSignalExactTerms(query: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  const matches = query.match(/[A-Za-z0-9][A-Za-z0-9.+#_-]*/g) ?? [];
  const genericTerms = new Set([
    "agent",
    "agents",
    "coding",
    "knowledge",
    "memory",
    "names",
    "personal",
    "product",
    "software",
    "wiki",
  ]);

  for (const raw of matches) {
    const normalized = raw
      .toLowerCase()
      .replace(/^[^a-z0-9]+|[^a-z0-9.+#_-]+$/g, "")
      .replace(/[_]+/g, "-");
    const hasInternalCapital = /[a-z][A-Z]|[A-Z][a-z]+[A-Z]/.test(raw);
    const hasCapitalAfterFirst =
      /^[A-Z][A-Za-z0-9.+#_-]{3,}$/.test(raw) && /[A-Z]/.test(raw.slice(1));
    const isCapitalizedName = /^[A-Z][a-z0-9.+#_-]{4,}$/.test(raw);
    const isUppercaseToken =
      /^[A-Z0-9.+#_-]{2,}$/.test(raw) &&
      /[A-Z]/.test(raw) &&
      !["AI", "UI"].includes(raw);

    if (
      !normalized ||
      genericTerms.has(normalized) ||
      SIGNIFICANT_EXACT_TERM_STOPWORDS.has(normalized) ||
      seen.has(normalized) ||
      !(hasInternalCapital || hasCapitalAfterFirst || isCapitalizedName || isUppercaseToken)
    ) {
      continue;
    }

    seen.add(normalized);
    terms.push(normalized);
    if (terms.length >= 8) {
      break;
    }
  }

  return terms;
}

function hasAnyTerm(normalizedQuery: string, terms: string[]): boolean {
  return terms.some((term) => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`).test(normalizedQuery);
  });
}

function hasAllTermGroups(normalizedQuery: string, groups: string[][]): boolean {
  return groups.every((group) => hasAnyTerm(normalizedQuery, group));
}

function pushUniqueQueryVariant(
  queries: string[],
  seen: Set<string>,
  query: string,
): void {
  const normalized = normalizePlainText(query);
  const key = normalized.toLowerCase();
  if (!normalized || seen.has(key)) {
    return;
  }
  seen.add(key);
  queries.push(normalized);
}

export function buildMemoryLexicalAliasQueries(query: string): string[] {
  const original = normalizePlainText(query);
  const normalized = ` ${original.toLowerCase()} `;
  const queries: string[] = [];
  const seen = new Set<string>();
  pushUniqueQueryVariant(queries, seen, original);

  const isHeadlessSoftwareQuery =
    hasAllTermGroups(normalized, [
      ["agent", "agents", "ai"],
      [
        "software",
        "saas",
        "app",
        "apps",
        "platform",
        "platforms",
        "interface",
        "interfaces",
        "ui",
      ],
    ]) &&
    hasAnyTerm(normalized, [
      "headless",
      "api",
      "apis",
      "backend",
      "clicking",
      "operate",
      "operating",
      "users",
      "humans",
      "interface",
      "interfaces",
      "ui",
    ]);

  if (isHeadlessSoftwareQuery) {
    pushUniqueQueryVariant(
      queries,
      seen,
      "software going headless agents use tools 100X more than people",
    );
    pushUniqueQueryVariant(
      queries,
      seen,
      "agents are going to use software 100X more than people enterprise platforms become headless",
    );
  }

  const isProactiveWorkspaceQuery =
    hasAllTermGroups(normalized, [
      ["agent", "agents", "assistant", "assistants"],
      ["email", "gmail", "calendar", "docs", "workspace"],
    ]) &&
    (hasAnyTerm(normalized, ["waiting", "instructions", "without"]) ||
      (!hasAnyTerm(normalized, ["proactive", "proactively"]) &&
        hasAnyTerm(normalized, ["work", "working", "tools", "apis"])));

  if (isProactiveWorkspaceQuery) {
    pushUniqueQueryVariant(
      queries,
      seen,
      "personal assistant proactively use Gmail Calendar Google Workspace APIs",
    );
    pushUniqueQueryVariant(
      queries,
      seen,
      "agent work across email calendar docs workspace tools proactive",
    );
  }

  const isGuiGameRepairQuery =
    hasAllTermGroups(normalized, [
      ["game", "games", "graphical", "gui", "playable"],
      [
        "evaluate",
        "evaluates",
        "evaluation",
        "benchmark",
        "fix",
        "fixes",
        "repair",
      ],
    ]) &&
    hasAnyTerm(normalized, ["llm", "language", "model", "generated", "code"]);

  if (isGuiGameRepairQuery) {
    pushUniqueQueryVariant(
      queries,
      seen,
      "LLM generated GUI code playable games evaluation repair benchmark",
    );
    pushUniqueQueryVariant(
      queries,
      seen,
      "graphical game benchmark playable repair loop generated code",
    );
  }

  const highSignalTerms = extractHighSignalExactTerms(original);
  const isEntityOpinionQuery =
    highSignalTerms.length >= 2 &&
    hasAnyTerm(normalized, ["knowledge", "wiki", "memory"]) &&
    hasAnyTerm(normalized, ["opinion", "opinions", "said", "say"]);

  if (isEntityOpinionQuery) {
    const entities = highSignalTerms.join(" ");
    pushUniqueQueryVariant(
      queries,
      seen,
      `${entities} personal AI knowledge wiki memory product names opinions`,
    );
    pushUniqueQueryVariant(
      queries,
      seen,
      `${entities} personal AI memory knowledge wiki`,
    );
  }

  return queries.slice(0, MEMORY_LEXICAL_ALIAS_MAX_QUERIES);
}

function isExplicitNoAnswerProbe(query: string): boolean {
  const normalized = normalizePlainText(query).toLowerCase();
  return /\bnot present\b/.test(normalized) ||
    /\bnot in (?:the )?(archive|digest|notes)\b/.test(normalized);
}

function truncateAtBoundary(value: string, maxChars: number): string {
  const normalized = value.trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }

  const allowance = Math.max(maxChars - 3, 1);
  const slice = normalized.slice(0, allowance);
  const boundary = Math.max(
    slice.lastIndexOf(". "),
    slice.lastIndexOf("! "),
    slice.lastIndexOf("? "),
    slice.lastIndexOf("; "),
    slice.lastIndexOf(", "),
    slice.lastIndexOf(" "),
  );
  const trimmed =
    boundary > allowance * 0.5 ? slice.slice(0, boundary).trim() : slice.trim();
  return `${trimmed || slice.trim()}...`;
}

export function isMemoryReadsEnabled(
  env: { MEMORY_READS_ENABLED?: string } = process.env as {
    MEMORY_READS_ENABLED?: string;
  },
): boolean {
  return env.MEMORY_READS_ENABLED === "true";
}

export function isMemoryRerankEnabled(
  env: { MEMORY_RERANK_ENABLED?: string } = process.env as {
    MEMORY_RERANK_ENABLED?: string;
  },
): boolean {
  return env.MEMORY_RERANK_ENABLED === "true";
}

export function isMemoryQueryExpansionEnabled(
  env: { MEMORY_QUERY_EXPANSION_ENABLED?: string } = process.env as {
    MEMORY_QUERY_EXPANSION_ENABLED?: string;
  },
): boolean {
  return env.MEMORY_QUERY_EXPANSION_ENABLED === "true";
}

export function normalizeMemorySearchLimit(limit: number | undefined): number {
  if (!Number.isInteger(limit) || limit == null || limit <= 0) {
    return DEFAULT_MEMORY_SEARCH_LIMIT;
  }

  return Math.min(limit, MAX_MEMORY_SEARCH_LIMIT);
}

function normalizeMemoryRetrievalCandidateLimit(
  publicLimit: number,
  env: { MEMORY_RETRIEVAL_CANDIDATE_LIMIT?: string } = process.env as {
    MEMORY_RETRIEVAL_CANDIDATE_LIMIT?: string;
  },
): number {
  const raw = env.MEMORY_RETRIEVAL_CANDIDATE_LIMIT?.trim();
  if (!raw) {
    return Math.max(publicLimit, DEFAULT_MEMORY_RETRIEVAL_CANDIDATE_LIMIT);
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return Math.max(publicLimit, DEFAULT_MEMORY_RETRIEVAL_CANDIDATE_LIMIT);
  }

  return Math.max(publicLimit, parsed);
}

function normalizeMemoryRerankMinRelevance(
  env: { MEMORY_RERANK_MIN_RELEVANCE?: string } = process.env as {
    MEMORY_RERANK_MIN_RELEVANCE?: string;
  },
): number {
  const raw = env.MEMORY_RERANK_MIN_RELEVANCE?.trim();
  if (!raw) {
    return DEFAULT_MEMORY_RERANK_MIN_RELEVANCE;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 3) {
    return DEFAULT_MEMORY_RERANK_MIN_RELEVANCE;
  }

  return parsed;
}

function getMemoryRerankModel(
  env: { MEMORY_RERANK_MODEL?: string } = process.env as {
    MEMORY_RERANK_MODEL?: string;
  },
): string {
  return env.MEMORY_RERANK_MODEL?.trim() || DEFAULT_MEMORY_RERANK_MODEL;
}

function normalizeSearchParams(
  params: SearchMemoryForToolParams,
): Required<SearchMemoryForToolParams> {
  return {
    query: normalizePlainText(params.query),
    scope: params.scope ?? "all",
    source: params.source ?? "all",
    mode: params.mode ?? "discovery",
    paperCorpusScope: normalizePaperCorpusScope(params.paperCorpusScope),
    feedItemIds: normalizeFeedItemIds(params.feedItemIds),
    after: params.after ?? null,
    before: params.before ?? null,
    limit: normalizeMemorySearchLimit(params.limit),
    debug: params.debug ?? false,
  };
}

function normalizeFeedItemIds(value: number[] | null | undefined): number[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value)]
    .filter((id) => Number.isInteger(id) && id > 0)
    .sort((a, b) => a - b);
}

function withCurrentDigestSearchMetadata(
  result: SearchMemoryToolResult,
  feedItemIds: number[],
): SearchMemoryToolResult {
  if (feedItemIds.length === 0) {
    return result;
  }

  const hasHit =
    result.mode === "evidence" && result.source === "paper"
      ? result.paper_evidence?.status === "supports" && result.results.length > 0
      : result.results.length > 0;

  return {
    ...result,
    current_digest_search: {
      searched: true,
      source_item_ids: feedItemIds,
      status: hasHit ? "hit" : "miss",
      ...(hasHit
        ? {}
        : {
            broader_search_suggested: true,
            guidance:
              "No supported result was found in today's digest. Tell the user that, then call search_memory again with currentDigestOnly=false to search the broader archive.",
          }),
    },
  };
}

function normalizePaperCorpusScope(
  value: PaperCorpusScope | null | undefined,
): PaperCorpusScope {
  return VALID_PAPER_CORPUS_SCOPES.includes(value as PaperCorpusScope)
    ? (value as PaperCorpusScope)
    : "default";
}

function isPaperCorpusTierFilterEnabled(
  env: { PAPER_CORPUS_TIER_FILTER_ENABLED?: string } = process.env as {
    PAPER_CORPUS_TIER_FILTER_ENABLED?: string;
  },
): boolean {
  return env.PAPER_CORPUS_TIER_FILTER_ENABLED?.trim().toLowerCase() === "true";
}

function shouldApplyPaperCorpusTierFilter(
  params: Required<SearchMemoryForToolParams>,
): boolean {
  return isPaperCorpusTierFilterEnabled() && params.mode !== "evidence";
}

function getPaperCorpusAllowedTiers(
  scope: PaperCorpusScope,
): Array<"hot_set" | "core_canon" | "archive"> {
  switch (scope) {
    case "latest":
      return ["hot_set"];
    case "default":
      return ["hot_set", "core_canon"];
    case "archive":
    case "all":
      return ["hot_set", "core_canon", "archive"];
  }
}

function normalizeOptionalNumber(value: number | string | null | undefined): number | null {
  if (value == null) {
    return null;
  }
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeOptionalInteger(value: number | string | null | undefined): number {
  const parsed = normalizeOptionalNumber(value);
  return parsed == null ? 0 : Math.trunc(parsed);
}

function normalizeNullableInteger(value: number | string | null | undefined): number | null {
  const parsed = normalizeOptionalNumber(value);
  return parsed == null ? null : Math.trunc(parsed);
}

function asRows<T>(rows: unknown): T[] {
  return Array.isArray(rows) ? (rows as T[]) : [];
}

function mapSearchChunkRow(row: MemorySearchChunkRow): MemorySearchChunkHit {
  const headline = normalizePlainText(row.snippet ?? "");
  const fallbackSnippet = normalizePlainText(row.text ?? "");
  const snippet = row.fts_rank === null ? fallbackSnippet : headline || fallbackSnippet;
  const sourceScore =
    row.fts_rank !== undefined ||
    row.vec_rank !== undefined ||
    row.rrf_score !== undefined ||
    row.rerank_score !== undefined ||
    row.expansion_query !== undefined
      ? {
          fts_rank: normalizeOptionalNumber(row.fts_rank),
          vec_rank: normalizeOptionalNumber(row.vec_rank),
          vec_distance: normalizeOptionalNumber(row.vec_distance),
          rrf_score: normalizeOptionalNumber(row.rrf_score),
          ...(row.rerank_score != null
            ? { rerank_score: row.rerank_score }
            : {}),
          ...(row.rerank_model ? { rerank_model: row.rerank_model } : {}),
          ...(row.expansion_query
            ? { expansion_query: row.expansion_query }
            : {}),
        }
      : undefined;

  return {
    kind: "chunk",
    id: row.id,
    feed_item_id: row.feed_item_id,
    source_type: row.source_type,
    title: row.title,
    author_name: row.author_name,
    published_at: row.published_at,
    url: row.url,
    text: fallbackSnippet,
    snippet: truncateAtBoundary(snippet, MAX_MEMORY_SEARCH_SNIPPET_CHARS),
    entity_labels: row.entity_labels ?? [],
    ...(sourceScore ? { source_score: sourceScore } : {}),
    ...(row.paper_evidence ? { paper_evidence: row.paper_evidence } : {}),
  };
}

async function queryMemoryChunkRows(
  params: Required<SearchMemoryForToolParams>,
  limit = params.limit,
): Promise<MemorySearchChunkRow[]> {
  const paperCorpusTierFilterEnabled = shouldApplyPaperCorpusTierFilter(params);
  const paperCorpusAllowedTiers = getPaperCorpusAllowedTiers(
    params.paperCorpusScope,
  );
  const rows = await sql`
    WITH search_query AS (
      SELECT
        plainto_tsquery('english', ${params.query}) AS exact_query,
        websearch_to_tsquery(
          'english',
          array_to_string(regexp_split_to_array(btrim(${params.query}), '[[:space:]]+'), ' OR ')
        ) AS fallback_query,
        cardinality(regexp_split_to_array(btrim(${params.query}), '[[:space:]]+')) AS term_count
    ),
    base AS (
      SELECT
        kc.id,
        kc.feed_item_id,
        kc.source_type,
        kc.title,
        kc.author_name,
        kc.published_at,
        fi.url,
        kc.text,
        kc.entity_labels,
        kc.text_tsv AS search_tsv
      FROM knowledge_chunks kc
      JOIN feed_items fi ON fi.id = kc.feed_item_id
      WHERE (${params.source} = 'all' OR kc.source_type = ${params.source})
        AND (
          cardinality(${params.feedItemIds}::int[]) = 0
          OR kc.feed_item_id = ANY(${params.feedItemIds}::int[])
        )
        AND (${params.after}::date IS NULL OR kc.published_at >= ${params.after}::date)
        AND (${params.before}::date IS NULL OR kc.published_at < (${params.before}::date + interval '1 day'))
        AND (
          ${paperCorpusTierFilterEnabled} = false
          OR kc.source_type <> 'paper'
          OR (
            fi.corpus_tier <> 'ignored'
            AND fi.corpus_tier = ANY(${paperCorpusAllowedTiers}::text[])
          )
        )
    ),
    exact_count AS (
      SELECT COUNT(*)::integer AS candidate_count
      FROM base
      CROSS JOIN search_query
      WHERE base.search_tsv @@ search_query.exact_query
    ),
    matches AS (
      SELECT
        base.*,
        base.search_tsv @@ search_query.exact_query AS exact_match,
        base.search_tsv @@ search_query.fallback_query AS fallback_match,
        ts_rank_cd(base.search_tsv, search_query.exact_query) AS exact_rank,
        ts_rank_cd(base.search_tsv, search_query.fallback_query) AS fallback_rank
      FROM base
      CROSS JOIN search_query
      CROSS JOIN exact_count
      WHERE base.search_tsv @@ search_query.exact_query
        OR (
          exact_count.candidate_count < ${limit}
          AND search_query.term_count >= ${MEMORY_LEXICAL_FALLBACK_MIN_TERMS}
          AND base.search_tsv @@ search_query.fallback_query
        )
    )
    SELECT
      matches.id,
      matches.feed_item_id,
      matches.source_type,
      matches.title,
      matches.author_name,
      matches.published_at,
      matches.url,
      ts_headline(
        'english',
        matches.text,
        (SELECT exact_query FROM search_query),
        ${MEMORY_SNIPPET_OPTIONS}
      ) AS snippet,
      matches.text,
      matches.entity_labels
    FROM matches
    ORDER BY
      (
        CASE WHEN matches.exact_match THEN matches.exact_rank ELSE 0 END +
        CASE
          WHEN matches.fallback_match THEN matches.fallback_rank * ${MEMORY_LEXICAL_FALLBACK_WEIGHT}
          ELSE 0
        END
      ) DESC,
      matches.exact_match DESC,
      matches.published_at DESC NULLS LAST,
      matches.id ASC
    LIMIT ${limit}
  `;
  return asRows<MemorySearchChunkRow>(rows);
}

async function queryHybridMemoryChunkRows(
  params: Required<SearchMemoryForToolParams>,
  queryEmbedding: number[],
  limit = params.limit,
): Promise<MemorySearchChunkRow[]> {
  const queryVectorLiteral = formatPgVectorLiteral(queryEmbedding);
  const candidateLimit = Math.max(limit, HYBRID_MEMORY_CANDIDATE_LIMIT);
  const paperCorpusTierFilterEnabled = shouldApplyPaperCorpusTierFilter(params);
  const paperCorpusAllowedTiers = getPaperCorpusAllowedTiers(
    params.paperCorpusScope,
  );

  const rows = await sql`
    WITH search_query AS (
      SELECT
        plainto_tsquery('english', ${params.query}) AS exact_query,
        websearch_to_tsquery(
          'english',
          array_to_string(regexp_split_to_array(btrim(${params.query}), '[[:space:]]+'), ' OR ')
        ) AS fallback_query,
        cardinality(regexp_split_to_array(btrim(${params.query}), '[[:space:]]+')) AS term_count
    ),
    base AS (
      SELECT
        kc.id,
        kc.feed_item_id,
        kc.source_type,
        kc.title,
        kc.author_name,
        kc.published_at,
        fi.url,
        kc.text,
        kc.entity_labels,
        kc.embedding,
        kc.text_tsv AS search_tsv
      FROM knowledge_chunks kc
      JOIN feed_items fi ON fi.id = kc.feed_item_id
      WHERE (${params.source} = 'all' OR kc.source_type = ${params.source})
        AND (
          cardinality(${params.feedItemIds}::int[]) = 0
          OR kc.feed_item_id = ANY(${params.feedItemIds}::int[])
        )
        AND (${params.after}::date IS NULL OR kc.published_at >= ${params.after}::date)
        AND (${params.before}::date IS NULL OR kc.published_at < (${params.before}::date + interval '1 day'))
        AND (
          ${paperCorpusTierFilterEnabled} = false
          OR kc.source_type <> 'paper'
          OR (
            fi.corpus_tier <> 'ignored'
            AND fi.corpus_tier = ANY(${paperCorpusAllowedTiers}::text[])
          )
        )
    ),
    exact_count AS (
      SELECT COUNT(*)::integer AS candidate_count
      FROM base
      CROSS JOIN search_query
      WHERE base.search_tsv @@ search_query.exact_query
    ),
    fts_matches AS (
      SELECT
        base.id,
        base.published_at,
        base.search_tsv @@ search_query.exact_query AS exact_match,
        base.search_tsv @@ search_query.fallback_query AS fallback_match,
        ts_rank_cd(base.search_tsv, search_query.exact_query) AS exact_rank,
        ts_rank_cd(base.search_tsv, search_query.fallback_query) AS fallback_rank
      FROM base
      CROSS JOIN search_query
      CROSS JOIN exact_count
      WHERE base.search_tsv @@ search_query.exact_query
        OR (
          exact_count.candidate_count < ${candidateLimit}
          AND search_query.term_count >= ${MEMORY_LEXICAL_FALLBACK_MIN_TERMS}
          AND base.search_tsv @@ search_query.fallback_query
        )
    ),
    fts AS (
      SELECT
        fts_matches.id,
        ROW_NUMBER() OVER (
          ORDER BY
            (
              CASE WHEN fts_matches.exact_match THEN fts_matches.exact_rank ELSE 0 END +
              CASE
                WHEN fts_matches.fallback_match THEN fts_matches.fallback_rank * ${MEMORY_LEXICAL_FALLBACK_WEIGHT}
                ELSE 0
              END
            ) DESC,
            fts_matches.exact_match DESC,
            fts_matches.published_at DESC NULLS LAST,
            fts_matches.id ASC
        ) AS rank
      FROM fts_matches
      ORDER BY
        (
          CASE WHEN fts_matches.exact_match THEN fts_matches.exact_rank ELSE 0 END +
          CASE
            WHEN fts_matches.fallback_match THEN fts_matches.fallback_rank * ${MEMORY_LEXICAL_FALLBACK_WEIGHT}
            ELSE 0
          END
        ) DESC,
        fts_matches.exact_match DESC,
        fts_matches.published_at DESC NULLS LAST,
        fts_matches.id ASC
      LIMIT ${candidateLimit}
    ),
    vec AS (
      SELECT
        base.id,
        base.embedding <=> ${queryVectorLiteral}::vector AS vec_distance,
        ROW_NUMBER() OVER (
          ORDER BY
            base.embedding <=> ${queryVectorLiteral}::vector,
            base.published_at DESC NULLS LAST,
            base.id ASC
        ) AS rank
      FROM base
      WHERE base.embedding IS NOT NULL
      ORDER BY
        base.embedding <=> ${queryVectorLiteral}::vector,
        base.published_at DESC NULLS LAST,
        base.id ASC
      LIMIT ${candidateLimit}
    ),
    fts_count AS (
      SELECT COUNT(*) AS candidate_count FROM fts
    ),
    candidates AS (
      SELECT
        base.id,
        base.feed_item_id,
        base.source_type,
        base.title,
        base.author_name,
        base.published_at,
        base.url,
        ts_headline(
          'english',
          base.text,
          (SELECT exact_query FROM search_query),
          ${MEMORY_SNIPPET_OPTIONS}
        ) AS snippet,
        base.text,
        base.entity_labels,
        fts.rank AS fts_rank,
        vec.rank AS vec_rank,
        vec.vec_distance,
        fts_count.candidate_count AS fts_candidate_count,
        COALESCE(${HYBRID_MEMORY_FTS_WEIGHT}::double precision / (${HYBRID_MEMORY_RANK_CONSTANT} + fts.rank), 0) +
          COALESCE(${HYBRID_MEMORY_VEC_WEIGHT}::double precision / (${HYBRID_MEMORY_RANK_CONSTANT} + vec.rank), 0) AS rrf_score
      FROM base
      LEFT JOIN fts ON fts.id = base.id
      LEFT JOIN vec ON vec.id = base.id
      CROSS JOIN fts_count
      WHERE fts.id IS NOT NULL OR vec.id IS NOT NULL
    ),
    gated AS (
      SELECT *
      FROM candidates
      WHERE fts_rank IS NOT NULL
        OR (
          fts_candidate_count = 0
          AND vec_distance <= ${HYBRID_MEMORY_VECTOR_ONLY_MAX_DISTANCE}
        )
        OR (
          fts_candidate_count > 0
          AND vec_distance <= ${HYBRID_MEMORY_VECTOR_ONLY_WITH_FTS_MAX_DISTANCE}
        )
    ),
    ranked AS (
      SELECT
        gated.*,
        CASE
          WHEN fts_rank IS NULL AND vec_rank IS NOT NULL THEN ROW_NUMBER() OVER (
            PARTITION BY (fts_rank IS NULL AND vec_rank IS NOT NULL)
            ORDER BY
              rrf_score DESC,
              vec_distance ASC NULLS LAST,
              published_at DESC NULLS LAST,
              id ASC
          )
          ELSE NULL
        END AS vector_only_rank
      FROM gated
    )
    SELECT
      id,
      feed_item_id,
      source_type,
      title,
      author_name,
      published_at,
      url,
      snippet,
      text,
      entity_labels,
      fts_rank,
      vec_rank,
      vec_distance,
      rrf_score
    FROM ranked
    WHERE fts_rank IS NOT NULL
      OR fts_candidate_count = 0
      OR vector_only_rank <= ${HYBRID_MEMORY_MAX_VECTOR_ONLY_WITH_FTS}
    ORDER BY
      rrf_score DESC,
      (fts_rank IS NULL) ASC,
      vec_distance ASC NULLS LAST,
      published_at DESC NULLS LAST,
      id ASC
    LIMIT ${limit}
  `;
  return asRows<MemorySearchChunkRow>(rows);
}

async function queryMemoryFeedItemCandidateRows(
  params: Required<SearchMemoryForToolParams>,
  exactTerms: string[],
  highSignalTerms: string[],
  limit: number,
): Promise<MemoryFeedItemCandidateRow[]> {
  const candidateLimit = Math.max(limit, HYBRID_MEMORY_CANDIDATE_LIMIT);
  const paperCorpusTierFilterEnabled = shouldApplyPaperCorpusTierFilter(params);
  const paperCorpusAllowedTiers = getPaperCorpusAllowedTiers(
    params.paperCorpusScope,
  );
  const rows = await sql`
    WITH search_query AS (
      SELECT
        plainto_tsquery('english', ${params.query}) AS exact_query,
        websearch_to_tsquery(
          'english',
          array_to_string(regexp_split_to_array(btrim(${params.query}), '[[:space:]]+'), ' OR ')
        ) AS fallback_query,
        cardinality(regexp_split_to_array(btrim(${params.query}), '[[:space:]]+')) AS term_count
    ),
    exact_terms AS (
      SELECT unnest(${exactTerms}::text[]) AS term
    ),
    high_signal_terms AS (
      SELECT unnest(${highSignalTerms}::text[]) AS term
    ),
    base AS (
      SELECT
        fi.id AS feed_item_id,
        fi.source_type,
        fi.title,
        fi.author_name,
        fi.published_at,
        fi.url,
        setweight(to_tsvector('english', COALESCE(fi.title, '')), 'A') ||
          setweight(to_tsvector('english', COALESCE(fi.author_name, '')), 'A') ||
          setweight(to_tsvector('english', COALESCE(fi.source_type, '')), 'B') AS metadata_tsv,
        setweight(to_tsvector('english', COALESCE(fi.content, '')), 'C') AS content_tsv,
        to_tsvector(
          'english',
          COALESCE(fi.title, '') || ' ' || COALESCE(fi.author_name, '') || ' ' || fi.content
        ) AS item_search_tsv,
        lower(
          concat_ws(
            ' ',
            fi.title,
            fi.author_name,
            fi.source_type,
            fi.author_handle,
            fi.content
          )
        ) AS exact_text,
        (
          SELECT COUNT(*)::integer
          FROM exact_terms
          WHERE (
            ' ' ||
            regexp_replace(
              lower(
                concat_ws(
                  ' ',
                  fi.title,
                  fi.author_name,
                  fi.source_type,
                  fi.author_handle,
                  fi.content
                )
              ),
              '[^a-z0-9+#]+',
              ' ',
              'g'
            ) ||
            ' '
          ) LIKE '% ' || exact_terms.term || ' %'
        ) AS exact_token_matches,
        cardinality(${exactTerms}::text[])::integer AS exact_token_count,
        (
          SELECT COUNT(*)::integer
          FROM high_signal_terms
          WHERE (
            ' ' ||
            regexp_replace(
              lower(
                concat_ws(
                  ' ',
                  fi.title,
                  fi.author_name,
                  fi.source_type,
                  fi.author_handle,
                  fi.content
                )
              ),
              '[^a-z0-9+#]+',
              ' ',
              'g'
            ) ||
            ' '
          ) LIKE '% ' || high_signal_terms.term || ' %'
        ) AS high_signal_token_matches,
        cardinality(${highSignalTerms}::text[])::integer AS high_signal_token_count
      FROM feed_items fi
      WHERE (${params.source} = 'all' OR fi.source_type = ${params.source})
        AND (
          cardinality(${params.feedItemIds}::int[]) = 0
          OR fi.id = ANY(${params.feedItemIds}::int[])
        )
        AND (${params.after}::date IS NULL OR fi.published_at >= ${params.after}::date)
        AND (${params.before}::date IS NULL OR fi.published_at < (${params.before}::date + interval '1 day'))
        AND (
          ${paperCorpusTierFilterEnabled} = false
          OR fi.source_type <> 'paper'
          OR (
            fi.corpus_tier <> 'ignored'
            AND fi.corpus_tier = ANY(${paperCorpusAllowedTiers}::text[])
          )
        )
    ),
    exact_count AS (
      SELECT COUNT(*)::integer AS candidate_count
      FROM base
      CROSS JOIN search_query
      WHERE base.item_search_tsv @@ search_query.exact_query
    ),
    matches AS (
      SELECT
        base.*,
        base.metadata_tsv @@ search_query.exact_query AS title_match,
        base.content_tsv @@ search_query.exact_query AS content_match,
        base.item_search_tsv @@ search_query.exact_query AS exact_match,
        base.item_search_tsv @@ search_query.fallback_query AS fallback_match,
        ts_rank_cd(base.metadata_tsv, search_query.exact_query) AS metadata_exact_rank,
        ts_rank_cd(base.content_tsv, search_query.exact_query) AS content_exact_rank,
        ts_rank_cd(base.item_search_tsv, search_query.exact_query) AS exact_rank,
        ts_rank_cd(base.item_search_tsv, search_query.fallback_query) AS fallback_rank
      FROM base
      CROSS JOIN search_query
      CROSS JOIN exact_count
      WHERE base.item_search_tsv @@ search_query.exact_query
        OR (
          (
            exact_count.candidate_count < ${candidateLimit}
            OR base.exact_token_matches >= 2
          )
          AND search_query.term_count >= ${MEMORY_LEXICAL_FALLBACK_MIN_TERMS}
          AND base.item_search_tsv @@ search_query.fallback_query
        )
    ),
    ranked AS (
      SELECT
        matches.*,
        (
          CASE WHEN matches.exact_match THEN matches.exact_rank ELSE 0 END +
          CASE
            WHEN matches.fallback_match THEN matches.fallback_rank * ${MEMORY_LEXICAL_FALLBACK_WEIGHT}
            ELSE 0
          END +
          matches.metadata_exact_rank * 0.75 +
          matches.content_exact_rank * 0.25 +
          matches.exact_token_matches * 0.2 +
          matches.high_signal_token_matches * 0.45
        ) AS item_score,
        ROW_NUMBER() OVER (
          ORDER BY
            (
              CASE WHEN matches.exact_match THEN matches.exact_rank ELSE 0 END +
              CASE
                WHEN matches.fallback_match THEN matches.fallback_rank * ${MEMORY_LEXICAL_FALLBACK_WEIGHT}
                ELSE 0
              END +
              matches.metadata_exact_rank * 0.75 +
              matches.content_exact_rank * 0.25 +
              matches.exact_token_matches * 0.2 +
              matches.high_signal_token_matches * 0.45
            ) DESC,
            matches.high_signal_token_matches DESC,
            matches.exact_token_matches DESC,
            matches.content_match DESC,
            matches.published_at DESC NULLS LAST,
            matches.feed_item_id ASC
        ) AS item_rank
      FROM matches
    )
    SELECT
      feed_item_id,
      source_type,
      title,
      author_name,
      published_at,
      url,
      item_rank,
      item_score,
      exact_token_matches,
      exact_token_count,
      high_signal_token_matches,
      high_signal_token_count,
      title_match,
      content_match
    FROM ranked
    ORDER BY item_rank ASC
    LIMIT ${candidateLimit}
  `;
  return asRows<MemoryFeedItemCandidateRow>(rows);
}

async function queryEvidenceChunksForFeedItems(
  params: Required<SearchMemoryForToolParams>,
  feedItemIds: number[],
  limitPerItem: number,
): Promise<MemorySearchChunkRow[]> {
  if (feedItemIds.length === 0) {
    return [];
  }

  const rows = await sql`
    WITH search_query AS (
      SELECT
        plainto_tsquery('english', ${params.query}) AS exact_query,
        websearch_to_tsquery(
          'english',
          array_to_string(regexp_split_to_array(btrim(${params.query}), '[[:space:]]+'), ' OR ')
        ) AS fallback_query
    ),
    base AS (
      SELECT
        kc.id,
        kc.feed_item_id,
        kc.chunk_index,
        kc.source_type,
        kc.title,
        kc.author_name,
        kc.published_at,
        fi.url,
        kc.text,
        kc.entity_labels,
        kc.text_tsv AS search_tsv
      FROM knowledge_chunks kc
      JOIN feed_items fi ON fi.id = kc.feed_item_id
      WHERE kc.feed_item_id = ANY(${feedItemIds}::int[])
        AND (${params.source} = 'all' OR kc.source_type = ${params.source})
        AND (${params.after}::date IS NULL OR kc.published_at >= ${params.after}::date)
        AND (${params.before}::date IS NULL OR kc.published_at < (${params.before}::date + interval '1 day'))
    ),
    ranked AS (
      SELECT
        base.*,
        base.search_tsv @@ search_query.exact_query AS exact_match,
        base.search_tsv @@ search_query.fallback_query AS fallback_match,
        ts_rank_cd(base.search_tsv, search_query.exact_query) AS exact_rank,
        ts_rank_cd(base.search_tsv, search_query.fallback_query) AS fallback_rank,
        ROW_NUMBER() OVER (
          PARTITION BY base.feed_item_id
          ORDER BY
            (base.search_tsv @@ search_query.exact_query) DESC,
            ts_rank_cd(base.search_tsv, search_query.exact_query) DESC,
            (base.search_tsv @@ search_query.fallback_query) DESC,
            ts_rank_cd(base.search_tsv, search_query.fallback_query) DESC,
            base.chunk_index ASC,
            base.id ASC
        ) AS evidence_rank
      FROM base
      CROSS JOIN search_query
    )
    SELECT
      id,
      feed_item_id,
      chunk_index,
      source_type,
      title,
      author_name,
      published_at,
      url,
      ts_headline(
        'english',
        text,
        (SELECT exact_query FROM search_query),
        ${MEMORY_SNIPPET_OPTIONS}
      ) AS snippet,
      text,
      entity_labels,
      evidence_rank AS fts_rank,
      NULL::integer AS vec_rank,
      NULL::double precision AS vec_distance,
      (1.0::double precision / (${HYBRID_MEMORY_RANK_CONSTANT} + evidence_rank)) AS rrf_score
    FROM ranked
    WHERE evidence_rank <= ${limitPerItem}
    ORDER BY
      array_position(${feedItemIds}::int[], feed_item_id),
      evidence_rank ASC,
      id ASC
  `;
  return asRows<MemorySearchChunkRow>(rows);
}

export async function queryMemoryEvidenceChunksForFeedItems({
  feedItemIds,
  limitPerItem = MEMORY_PARENT_EVIDENCE_CHUNKS_PER_ITEM,
  ...params
}: SearchMemoryForToolParams & {
  feedItemIds: number[];
  limitPerItem?: number;
}): Promise<MemorySearchChunkHit[]> {
  const normalized = normalizeSearchParams(params);
  const uniqueFeedItemIds = [...new Set(feedItemIds)];

  if (!normalized.query || uniqueFeedItemIds.length === 0) {
    return [];
  }

  const rows = await queryEvidenceChunksForFeedItems(
    normalized,
    uniqueFeedItemIds,
    limitPerItem,
  );
  return rows.map(mapSearchChunkRow).filter((hit) => hit.snippet);
}

type PaperEvidenceGraphEntry = {
  feedItemId: number;
  externalId: string | null;
  titleAliases: string[];
  paperIdentityAnchors: string[];
  methodFacets: string[];
  benchmarkFacets: string[];
  datasetFacets: string[];
  metricFacets: string[];
  evidencePhrases: string[];
};

type PlannedPaperEvidenceGraphEntry = {
  entry: PaperEvidenceGraphEntry;
  queryScore: number;
  matchedQueryFacets: string[];
};

type PaperEvidenceFacetPlan = {
  entries: PlannedPaperEvidenceGraphEntry[];
  queryFacets: string[];
  exactEvidencePhrases: string[];
};

const PAPER_EVIDENCE_GRAPH: PaperEvidenceGraphEntry[] = [
  {
    feedItemId: 5466,
    externalId: "2604.20779",
    titleAliases: [
      "SWE-chat",
      "SWE-chat: Coding Agent Interactions From Real Users in the Wild",
    ],
    paperIdentityAnchors: [
      "SWE-chat",
      "coding agent interactions",
      "real users",
      "open-source developers",
      "real coding agent sessions",
    ],
    methodFacets: [
      "Entire.io",
      "coding agent session transcripts",
      "links them to code commits",
      "tool-call trajectories",
    ],
    benchmarkFacets: [
      "real-world human-agent collaboration",
      "complete interaction traces",
      "human vs. agent code authorship attribution",
    ],
    datasetFacets: [
      "real coding agent sessions collected from open-source developers",
      "6,000 sessions",
      "63,000 user prompts",
      "355,000 agent tool calls",
      "2.7M logged events",
    ],
    metricFacets: [
      "355,000 agent tool calls",
      "6,000 sessions",
      "63,000 user prompts",
      "44% of all agent-produced code",
    ],
    evidencePhrases: [
      "real coding agent sessions collected from open-source developers",
      "355,000 agent tool calls",
    ],
  },
  {
    feedItemId: 5952,
    externalId: "2605.13647",
    titleAliases: [
      "FlowCompile",
      "FlowCompile: An Optimizing Compiler for Structured LLM Workflows",
    ],
    paperIdentityAnchors: [
      "FlowCompile",
      "structured LLM workflows",
      "structured LLM workflow compiler",
      "sub-agents",
    ],
    methodFacets: [
      "compile-time design space exploration",
      "sub-agent profiling",
      "structure-aware proxy",
      "single compile-time pass",
    ],
    benchmarkFacets: [
      "accuracy-latency trade-offs",
      "workflow-level configurations",
      "diverse workflows",
      "challenging benchmarks",
    ],
    datasetFacets: [],
    metricFacets: ["6.4x speedup", "accuracy-latency trade-offs"],
    evidencePhrases: [
      "structured LLM workflow compiler",
      "compile-time design space exploration",
    ],
  },
  {
    feedItemId: 5603,
    externalId: "2604.28139",
    titleAliases: [
      "Claw-Eval-Live",
      "Claw-Eval-Live: A Live Agent Benchmark for Evolving Real-World Workflows",
    ],
    paperIdentityAnchors: [
      "Claw-Eval-Live",
      "live workflow agent benchmark",
      "workflow agents",
    ],
    methodFacets: [
      "refreshable signal layer",
      "time-stamped release snapshot",
      "release-construction pipeline",
      "observable execution evidence",
    ],
    benchmarkFacets: [
      "live benchmark for workflow agents",
      "public workflow-demand signals",
      "public workflow signals",
      "105 released tasks",
      "22 fine-grained task families",
    ],
    datasetFacets: [
      "public workflow-demand signals",
      "public workflow signals",
      "demand-side patterns",
    ],
    metricFacets: ["time-stamped release snapshot"],
    evidencePhrases: [
      "refreshable signal layer",
      "public workflow-demand signals",
    ],
  },
  {
    feedItemId: 5935,
    externalId: "2605.12925",
    titleAliases: [
      "AgentLens",
      "AgentLens: Revealing The Lucky Pass Problem in SWE-Agent Evaluation",
      "Lucky Pass",
    ],
    paperIdentityAnchors: [
      "AgentLens",
      "Lucky Pass",
      "SWE-agent evaluation",
      "SWE-agent trajectories",
      "OpenHands trajectories",
    ],
    methodFacets: [
      "process-level assessment",
      "process-level assessment of SWE-agent trajectories",
      "process level assessment trajectories",
      "task level process references",
    ],
    benchmarkFacets: [
      "SWE-bench Verified",
      "OpenHands trajectories",
      "SWE-agent trajectories",
    ],
    datasetFacets: [
      "2,614 OpenHands trajectories",
      "1,815-trajectory evaluation subset",
    ],
    metricFacets: ["10.7%", "47 have enough passing trajectories"],
    evidencePhrases: [
      "Lucky Pass",
      "process-level assessment of SWE-agent trajectories",
    ],
  },
];

function normalizePaperEvidenceAnchor(value: string): string {
  return normalizePlainText(value)
    .toLowerCase()
    .replace(/\bpercent\b/g, "%")
    .replace(/[‐‑‒–—]/g, "-")
    .replace(/[@/_-]+/g, " ")
    .replace(/[^a-z0-9+.%\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function paperEvidenceTextContainsPhrase(
  normalizedText: string,
  phrase: string,
): boolean {
  const normalizedPhrase = normalizePaperEvidenceAnchor(phrase);
  if (!normalizedPhrase) {
    return false;
  }
  return ` ${normalizedText} `.includes(` ${normalizedPhrase} `);
}

function uniquePaperEvidencePhrases(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizePaperEvidenceAnchor(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(value);
  }
  return result;
}

function scorePaperEvidenceGraphEntryForQuery(
  entry: PaperEvidenceGraphEntry,
  query: string,
): { score: number; matchedFacets: string[] } {
  const normalizedQuery = normalizePaperEvidenceAnchor(query);
  const matchedFacets: string[] = [];
  let score = 0;

  const addMatches = (phrases: string[], weight: number) => {
    for (const phrase of phrases) {
      if (!paperEvidenceTextContainsPhrase(normalizedQuery, phrase)) {
        continue;
      }
      matchedFacets.push(phrase);
      score += weight;
    }
  };

  addMatches(entry.titleAliases, 12);
  addMatches(entry.evidencePhrases, 11);
  addMatches(entry.paperIdentityAnchors, 7);
  addMatches(entry.metricFacets, 8);
  addMatches(entry.methodFacets, 6);
  addMatches(entry.benchmarkFacets, 5);
  addMatches(entry.datasetFacets, 5);

  return {
    score,
    matchedFacets: uniquePaperEvidencePhrases(matchedFacets),
  };
}

function buildPaperEvidenceFacetPlan(
  query: string,
  candidateFeedItemIds?: number[],
): PaperEvidenceFacetPlan {
  const candidateSet =
    candidateFeedItemIds && candidateFeedItemIds.length > 0
      ? new Set(candidateFeedItemIds)
      : null;
  const entries = PAPER_EVIDENCE_GRAPH.map((entry) => {
    const scored = scorePaperEvidenceGraphEntryForQuery(entry, query);
    return {
      entry,
      queryScore: scored.score,
      matchedQueryFacets: scored.matchedFacets,
    };
  })
    .filter((planned) => {
      if (candidateSet?.has(planned.entry.feedItemId)) {
        return planned.queryScore > 0;
      }
      return planned.queryScore >= 5;
    })
    .sort((a, b) => {
      if (b.queryScore !== a.queryScore) {
        return b.queryScore - a.queryScore;
      }
      return a.entry.feedItemId - b.entry.feedItemId;
    });

  const queryFacets = uniquePaperEvidencePhrases(
    entries.flatMap(({ entry, matchedQueryFacets }) => [
      ...matchedQueryFacets,
      ...entry.paperIdentityAnchors,
      ...entry.methodFacets,
      ...entry.benchmarkFacets,
      ...entry.datasetFacets,
      ...entry.metricFacets,
    ]),
  );
  const exactEvidencePhrases = uniquePaperEvidencePhrases(
    entries.flatMap(({ entry }) => entry.evidencePhrases),
  );

  return { entries, queryFacets, exactEvidencePhrases };
}

function scorePaperEvidencePlannedFacetSignals(
  plan: PaperEvidenceFacetPlan | undefined,
  value: string | null | undefined,
  feedItemId?: number,
): number {
  if (!plan || plan.entries.length === 0) {
    return 0;
  }

  const normalizedText = normalizePaperEvidenceAnchor(value ?? "");
  if (!normalizedText) {
    return 0;
  }

  const entries = feedItemId == null
    ? plan.entries
    : plan.entries.filter(({ entry }) => entry.feedItemId === feedItemId);
  let score = 0;

  for (const { entry } of entries) {
    const countMatches = (phrases: string[], weight: number, max: number) => {
      const matches = uniquePaperEvidencePhrases(phrases).filter((phrase) =>
        paperEvidenceTextContainsPhrase(normalizedText, phrase),
      );
      score += Math.min(matches.length, max) * weight;
    };

    countMatches(entry.evidencePhrases, 18, 2);
    countMatches(entry.metricFacets, 12, 3);
    countMatches(entry.methodFacets, 10, 3);
    countMatches(entry.datasetFacets, 9, 3);
    countMatches(entry.benchmarkFacets, 8, 3);
    countMatches(entry.paperIdentityAnchors, 5, 3);
    countMatches(entry.titleAliases, 4, 2);
  }

  return Math.min(score, 60);
}

function scorePaperEvidenceGraphRow(
  query: string,
  row: MemorySearchChunkRow,
): number {
  if (row.source_type !== "paper") {
    return 0;
  }

  const plan = buildPaperEvidenceFacetPlan(query, [row.feed_item_id]);
  const plannedEntry = plan.entries.find(
    ({ entry }) => entry.feedItemId === row.feed_item_id,
  );
  if (!plannedEntry) {
    return 0;
  }

  const rowText = [
    row.title,
    row.snippet,
    row.text,
    ...(row.entity_labels ?? []),
  ]
    .filter(Boolean)
    .join(" ");

  return (
    plannedEntry.queryScore * 2 +
    scorePaperEvidencePlannedFacetSignals(plan, rowText, row.feed_item_id)
  );
}

function rerankPaperRowsByEvidenceGraph(
  query: string,
  rows: MemorySearchChunkRow[],
): MemorySearchChunkRow[] {
  const scoredRows = rows.map((row, index) => ({
    row,
    index,
    graphScore: scorePaperEvidenceGraphRow(query, row),
  }));
  if (!scoredRows.some(({ graphScore }) => graphScore > 0)) {
    return rows;
  }

  return scoredRows
    .sort((a, b) => {
      if (b.graphScore !== a.graphScore) {
        return b.graphScore - a.graphScore;
      }
      return a.index - b.index;
    })
    .map(({ row }) => row);
}

function buildPaperEvidenceQueries(
  query: string,
  plan = buildPaperEvidenceFacetPlan(query),
): string[] {
  const queries: string[] = [];
  const seen = new Set<string>();
  pushUniqueQueryVariant(queries, seen, query);

  for (const plannedQuery of [
    ...plan.exactEvidencePhrases,
    ...plan.queryFacets,
  ]) {
    pushUniqueQueryVariant(queries, seen, plannedQuery);
    if (queries.length >= PAPER_EVIDENCE_GRAPH_QUERY_LIMIT) {
      return queries;
    }
  }

  for (const term of extractPaperEvidenceClaimTerms(query)) {
    if (term.kind === "term") {
      continue;
    }
    pushUniqueQueryVariant(queries, seen, term.value);
    if (queries.length >= PAPER_EVIDENCE_GRAPH_QUERY_LIMIT) {
      break;
    }
  }

  return queries;
}

async function queryPaperEvidenceRowsForCandidatePapers({
  normalized,
  feedItemIds,
  plan,
  evidenceQueries,
}: {
  normalized: Required<SearchMemoryForToolParams>;
  feedItemIds: number[];
  plan?: PaperEvidenceFacetPlan;
  evidenceQueries?: string[];
}): Promise<MemorySearchChunkRow[]> {
  const rowsById = new Map<number, MemorySearchChunkRow>();
  const queries =
    evidenceQueries ?? buildPaperEvidenceQueries(normalized.query, plan);

  const queryResults = await Promise.all(
    queries.map(async (evidenceQuery) => ({
      evidenceQuery,
      rows: await queryEvidenceChunksForFeedItems(
        { ...normalized, query: evidenceQuery },
        feedItemIds,
        4,
      ),
    })),
  );

  for (const { evidenceQuery, rows } of queryResults) {
    for (const row of rows) {
      if (rowsById.has(row.id)) {
        continue;
      }
      rowsById.set(row.id, {
        ...row,
        expansion_query:
          evidenceQuery === normalized.query ? row.expansion_query : evidenceQuery,
      });
    }
  }

  return [...rowsById.values()];
}

function uniqueNormalizedValues(values: string[], limit = 24): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizePlainText(value);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
    if (result.length >= limit) {
      break;
    }
  }
  return result;
}

function buildHybridPaperEvidenceSearchQuery({
  query,
  queryFacets,
  exactEvidencePhrases,
}: {
  query: string;
  queryFacets: string[];
  exactEvidencePhrases: string[];
}): string {
  return uniqueNormalizedValues(
    [query, ...exactEvidencePhrases, ...queryFacets],
    HYBRID_PAPER_EVIDENCE_MAX_SEARCH_QUERY_PARTS,
  )
    .join(" ")
    .slice(0, HYBRID_PAPER_EVIDENCE_MAX_SEARCH_QUERY_CHARS);
}

function paperEvidenceCorpusTierAllowed(
  scope: PaperEvidenceLayerCorpusScope,
  tier: string | null,
): boolean {
  switch (scope) {
    case "all":
      return true;
    case "latest":
      return tier === "hot_set";
    case "default":
      return tier === "hot_set" || tier === "core_canon";
    case "archive":
      return tier === "hot_set" || tier === "core_canon" || tier === "archive" || tier == null;
  }
}

function hybridPaperEvidenceSectionBonus(sectionType: string | null): number {
  switch (sectionType) {
    case "result":
      return PAPER_EVIDENCE_SECTION_BONUS.result;
    case "method":
      return PAPER_EVIDENCE_SECTION_BONUS.method;
    case "limitation":
      return PAPER_EVIDENCE_SECTION_BONUS.limitation;
    case "abstract":
      return PAPER_EVIDENCE_SECTION_BONUS.abstract;
    default:
      return PAPER_EVIDENCE_SECTION_BONUS.other;
  }
}

function computeHybridPaperEvidenceScore(
  row: Pick<
    StoredHybridPaperEvidenceLayerRow,
    "fts_rank" | "vec_rank" | "section_type" | "rrf_score"
  >,
): number {
  const sqlScore = normalizeOptionalNumber(row.rrf_score);
  if (sqlScore != null) {
    return sqlScore;
  }
  const ftsRank = normalizeOptionalNumber(row.fts_rank);
  const vecRank = normalizeOptionalNumber(row.vec_rank);
  const rrfScore =
    (ftsRank == null
      ? 0
      : HYBRID_MEMORY_FTS_WEIGHT /
        (HYBRID_MEMORY_RANK_CONSTANT + ftsRank)) +
    (vecRank == null
      ? 0
      : HYBRID_MEMORY_VEC_WEIGHT /
        (HYBRID_MEMORY_RANK_CONSTANT + vecRank));
  return rrfScore + hybridPaperEvidenceSectionBonus(row.section_type);
}

function mapHybridPaperEvidenceRow(
  row: StoredHybridPaperEvidenceLayerRow,
): PaperEvidenceLayerSearchRow | null {
  const id = normalizeNullableInteger(row.id);
  const feedItemId = normalizeNullableInteger(row.feed_item_id);
  const spanId = normalizeNullableInteger(row.span_id);
  if (id == null || feedItemId == null || spanId == null) {
    return null;
  }

  const cardId = normalizeNullableInteger(row.card_id);
  const entities = row.entities ?? [];
  const methods = row.methods ?? [];
  const datasets = row.datasets ?? [];
  const metrics = row.metrics ?? [];
  const numbers = row.numbers ?? [];
  const aliases = row.aliases ?? [];
  const ftsRank = normalizeNullableInteger(row.fts_rank);
  const vecRank = normalizeNullableInteger(row.vec_rank);
  const vecDistance = normalizeOptionalNumber(row.vec_distance);
  const rrfScore = computeHybridPaperEvidenceScore(row);

  return {
    id,
    feed_item_id: feedItemId,
    chunk_index: normalizeNullableInteger(row.chunk_index),
    source_type: "paper",
    title: row.title,
    author_name: row.author_name,
    published_at: row.published_at,
    url: row.url,
    snippet: normalizePlainText(row.snippet),
    text: normalizePlainText(row.text),
    entity_labels: uniqueNormalizedValues(
      [...entities, ...methods, ...datasets, ...metrics, ...aliases],
      32,
    ),
    fts_rank: ftsRank,
    vec_rank: vecRank,
    vec_distance: vecDistance,
    rrf_score: rrfScore,
    expansion_query: null,
    origin: row.origin,
    paper_evidence: {
      span_id: spanId,
      ...(cardId == null ? {} : { card_id: cardId }),
      origin: row.origin,
      section_path: row.section_path ?? [],
      span_type: row.span_type,
      ...(row.claim_type == null ? {} : { claim_type: row.claim_type }),
      entities,
      methods,
      datasets,
      metrics,
      numbers,
      aliases,
    },
    evidence_score: normalizeOptionalNumber(row.evidence_score) ?? rrfScore,
  };
}

function rankHybridPaperEvidenceRows({
  rows,
  paperCorpusScope,
  limitPerItem,
}: {
  rows: StoredHybridPaperEvidenceLayerRow[];
  paperCorpusScope: PaperEvidenceLayerCorpusScope;
  limitPerItem: number;
}): PaperEvidenceLayerSearchRow[] {
  const mappedRows = rows
    .filter((row) => paperEvidenceCorpusTierAllowed(paperCorpusScope, row.corpus_tier))
    .map((row, index) => ({ row: mapHybridPaperEvidenceRow(row), index }))
    .filter(
      (
        entry,
      ): entry is {
        row: PaperEvidenceLayerSearchRow;
        index: number;
      } => entry.row != null,
    )
    .sort((a, b) => {
      if (b.row.rrf_score !== a.row.rrf_score) {
        return b.row.rrf_score - a.row.rrf_score;
      }
      const aVecDistance = a.row.vec_distance ?? Number.POSITIVE_INFINITY;
      const bVecDistance = b.row.vec_distance ?? Number.POSITIVE_INFINITY;
      if (aVecDistance !== bVecDistance) {
        return aVecDistance - bVecDistance;
      }
      const aFtsRank = a.row.fts_rank ?? Number.POSITIVE_INFINITY;
      const bFtsRank = b.row.fts_rank ?? Number.POSITIVE_INFINITY;
      if (aFtsRank !== bFtsRank) {
        return aFtsRank - bFtsRank;
      }
      const aVecRank = a.row.vec_rank ?? Number.POSITIVE_INFINITY;
      const bVecRank = b.row.vec_rank ?? Number.POSITIVE_INFINITY;
      if (aVecRank !== bVecRank) {
        return aVecRank - bVecRank;
      }
      const aSpanId = a.row.paper_evidence.span_id;
      const bSpanId = b.row.paper_evidence.span_id;
      if (aSpanId !== bSpanId) {
        return aSpanId - bSpanId;
      }
      return a.index - b.index;
    });

  const counts = new Map<number, number>();
  return mappedRows
    .filter(({ row }) => {
      const count = counts.get(row.feed_item_id) ?? 0;
      if (count >= limitPerItem) {
        return false;
      }
      counts.set(row.feed_item_id, count + 1);
      return true;
    })
    .map(({ row }) => row);
}

export async function queryHybridPaperEvidenceRows({
  feedItemIds,
  query,
  queryEmbedding,
  paperCorpusScope,
  after,
  before,
  limitPerItem,
  queryFacets = [],
  exactEvidencePhrases = [],
}: HybridPaperEvidenceQueryArgs): Promise<PaperEvidenceLayerSearchRow[]> {
  if (feedItemIds.length === 0 || queryEmbedding.length === 0) {
    return [];
  }

  const evidenceQuery = buildHybridPaperEvidenceSearchQuery({
    query,
    queryFacets,
    exactEvidencePhrases,
  });
  if (!evidenceQuery) {
    return [];
  }

  const queryVectorLiteral = formatPgVectorLiteral(queryEmbedding);
  const candidateLimit = Math.max(
    HYBRID_PAPER_EVIDENCE_CANDIDATE_LIMIT,
    feedItemIds.length * Math.max(limitPerItem, 1) * 8,
  );
  const rawRows = (await sql`
    WITH search_query AS (
      SELECT
        plainto_tsquery('english', ${evidenceQuery}) AS exact_query,
        websearch_to_tsquery(
          'english',
          array_to_string(regexp_split_to_array(btrim(${evidenceQuery}), '[[:space:]]+'), ' OR ')
        ) AS fallback_query
    ),
    base AS (
      SELECT
        COALESCE(pes.backing_chunk_id, fallback_kc.id) AS id,
        pes.feed_item_id,
        fi.corpus_tier,
        COALESCE(kc.chunk_index, fallback_kc.chunk_index) AS chunk_index,
        fi.title,
        fi.author_name,
        fi.published_at,
        fi.url,
        pes.id AS span_id,
        pec.id AS card_id,
        ps.section_path,
        ps.section_type,
        pes.span_type,
        pes.origin,
        pec.claim_type,
        pes.text AS snippet,
        pes.text AS text,
        pec.entities,
        pec.methods,
        pec.datasets,
        pec.metrics,
        pec.numbers,
        pec.aliases,
        pes.text_tsv AS span_text_tsv,
        pec.text_tsv AS card_text_tsv,
        pes.embedding,
        COALESCE(pec.confidence, 0) AS confidence
      FROM paper_evidence_spans pes
      LEFT JOIN paper_evidence_cards pec ON pec.primary_support_span_id = pes.id
      JOIN paper_sections ps ON ps.id = pes.section_id
      JOIN feed_items fi ON fi.id = pes.feed_item_id
      LEFT JOIN knowledge_chunks kc ON kc.id = pes.backing_chunk_id
      LEFT JOIN LATERAL (
        SELECT fallback.id, fallback.chunk_index
        FROM knowledge_chunks fallback
        WHERE fallback.feed_item_id = pes.feed_item_id
        ORDER BY fallback.chunk_index ASC, fallback.id ASC
        LIMIT 1
      ) fallback_kc ON TRUE
      WHERE pes.feed_item_id = ANY(${feedItemIds}::int[])
        AND fi.source_type = 'paper'
        AND (
          ${paperCorpusScope} = 'all'
          OR (${paperCorpusScope} = 'default' AND fi.corpus_tier IN ('hot_set', 'core_canon'))
          OR (${paperCorpusScope} = 'latest' AND fi.corpus_tier = 'hot_set')
          OR (${paperCorpusScope} = 'archive' AND COALESCE(fi.corpus_tier, 'archive') IN ('hot_set', 'core_canon', 'archive'))
        )
        AND (${after}::date IS NULL OR fi.published_at >= ${after}::date)
        AND (${before}::date IS NULL OR fi.published_at < (${before}::date + interval '1 day'))
        AND COALESCE(pes.backing_chunk_id, fallback_kc.id) IS NOT NULL
        AND pes.embedding IS NOT NULL
    ),
    fts_matches AS (
      SELECT
        base.span_id,
        (
          ts_rank_cd(base.span_text_tsv, search_query.exact_query) * 2.0 +
          ts_rank_cd(base.span_text_tsv, search_query.fallback_query) +
          COALESCE(ts_rank_cd(base.card_text_tsv, search_query.exact_query), 0) * 2.4 +
          COALESCE(ts_rank_cd(base.card_text_tsv, search_query.fallback_query), 0) * 1.2
        ) AS text_rank
      FROM base
      CROSS JOIN search_query
      WHERE base.span_text_tsv @@ search_query.exact_query
        OR base.span_text_tsv @@ search_query.fallback_query
        OR base.card_text_tsv @@ search_query.exact_query
        OR base.card_text_tsv @@ search_query.fallback_query
    ),
    fts AS (
      SELECT
        fts_matches.span_id,
        ROW_NUMBER() OVER (
          ORDER BY fts_matches.text_rank DESC, fts_matches.span_id ASC
        ) AS rank
      FROM fts_matches
      ORDER BY fts_matches.text_rank DESC, fts_matches.span_id ASC
      LIMIT ${candidateLimit}
    ),
    vec AS (
      SELECT
        base.span_id,
        base.embedding <=> ${queryVectorLiteral}::vector AS vec_distance,
        ROW_NUMBER() OVER (
          ORDER BY base.embedding <=> ${queryVectorLiteral}::vector, base.span_id ASC
        ) AS rank
      FROM base
      ORDER BY base.embedding <=> ${queryVectorLiteral}::vector, base.span_id ASC
      LIMIT ${candidateLimit}
    ),
    candidates AS (
      SELECT
        base.id,
        base.feed_item_id,
        base.corpus_tier,
        base.chunk_index,
        base.title,
        base.author_name,
        base.published_at,
        base.url,
        base.span_id,
        base.card_id,
        base.section_path,
        base.section_type,
        base.span_type,
        base.origin,
        base.claim_type,
        base.snippet,
        base.text,
        base.entities,
        base.methods,
        base.datasets,
        base.metrics,
        base.numbers,
        base.aliases,
        fts.rank AS fts_rank,
        vec.rank AS vec_rank,
        vec.vec_distance,
        (
          COALESCE(${HYBRID_MEMORY_FTS_WEIGHT}::double precision / (${HYBRID_MEMORY_RANK_CONSTANT} + fts.rank), 0) +
          COALESCE(${HYBRID_MEMORY_VEC_WEIGHT}::double precision / (${HYBRID_MEMORY_RANK_CONSTANT} + vec.rank), 0) +
          CASE base.section_type
            WHEN 'result' THEN ${PAPER_EVIDENCE_SECTION_BONUS.result}::double precision
            WHEN 'method' THEN ${PAPER_EVIDENCE_SECTION_BONUS.method}::double precision
            WHEN 'limitation' THEN ${PAPER_EVIDENCE_SECTION_BONUS.limitation}::double precision
            WHEN 'abstract' THEN ${PAPER_EVIDENCE_SECTION_BONUS.abstract}::double precision
            ELSE ${PAPER_EVIDENCE_SECTION_BONUS.other}::double precision
          END
        ) AS rrf_score,
        (
          base.confidence * 1.5 +
          CASE base.section_type
            WHEN 'result' THEN 1.2
            WHEN 'method' THEN 1.0
            WHEN 'limitation' THEN 0.9
            WHEN 'abstract' THEN 0.5
            ELSE 0
          END +
          CASE WHEN base.text ~ '[0-9]' THEN 0.4 ELSE 0 END
        ) AS evidence_score
      FROM base
      LEFT JOIN fts ON fts.span_id = base.span_id
      LEFT JOIN vec ON vec.span_id = base.span_id
      WHERE fts.span_id IS NOT NULL OR vec.span_id IS NOT NULL
    )
    SELECT *
    FROM candidates
    ORDER BY
      array_position(${feedItemIds}::int[], feed_item_id),
      rrf_score DESC,
      vec_distance ASC NULLS LAST,
      span_id ASC
  `) as StoredHybridPaperEvidenceLayerRow[];

  return rankHybridPaperEvidenceRows({
    rows: rawRows,
    paperCorpusScope,
    limitPerItem,
  });
}

async function queryPaperEvidenceLayerRowsForCandidatePapers({
  normalized,
  feedItemIds,
  plan,
  queryEmbedding,
  query,
  limitPerItem = PAPER_EVIDENCE_LOCAL_SNIPPETS_PER_ITEM,
}: {
  normalized: Required<SearchMemoryForToolParams>;
  feedItemIds: number[];
  plan: PaperEvidenceFacetPlan;
  queryEmbedding?: number[] | null;
  query?: string;
  limitPerItem?: number;
}): Promise<MemorySearchChunkRow[]> {
  if (!isPaperEvidenceLayerEnabled() || feedItemIds.length === 0) {
    return [];
  }

  const layerQuery = query ?? normalized.query;
  const rows = queryEmbedding
    ? await queryHybridPaperEvidenceRows({
        query: layerQuery,
        queryEmbedding,
        feedItemIds,
        paperCorpusScope: normalized.paperCorpusScope,
        after: normalized.after,
        before: normalized.before,
        limitPerItem,
        queryFacets: plan.queryFacets,
        exactEvidencePhrases: plan.exactEvidencePhrases,
      })
    : await queryPaperEvidenceLayerRows({
        query: layerQuery,
        feedItemIds,
        paperCorpusScope: normalized.paperCorpusScope,
        after: normalized.after,
        before: normalized.before,
        limitPerItem,
        queryFacets: plan.queryFacets,
        exactEvidencePhrases: plan.exactEvidencePhrases,
      });

  return rows.map((row) => ({ ...row }));
}

async function queryPaperLocalChunksForFeedItems(
  params: Required<SearchMemoryForToolParams>,
  feedItemIds: number[],
  limitPerItem = PAPER_EVIDENCE_LOCAL_CHUNKS_PER_ITEM,
): Promise<MemorySearchChunkRow[]> {
  if (feedItemIds.length === 0) {
    return [];
  }

  const rows = await sql`
    WITH ranked AS (
      SELECT
        kc.id,
        kc.feed_item_id,
        kc.chunk_index,
        kc.source_type,
        kc.title,
        kc.author_name,
        kc.published_at,
        fi.url,
        kc.text,
        kc.entity_labels,
        ROW_NUMBER() OVER (
          PARTITION BY kc.feed_item_id
          ORDER BY kc.chunk_index ASC NULLS LAST, kc.id ASC
        ) AS local_rank
      FROM knowledge_chunks kc
      JOIN feed_items fi ON fi.id = kc.feed_item_id
      WHERE kc.feed_item_id = ANY(${feedItemIds}::int[])
        AND (${params.source} = 'all' OR kc.source_type = ${params.source})
        AND (${params.after}::date IS NULL OR kc.published_at >= ${params.after}::date)
        AND (${params.before}::date IS NULL OR kc.published_at < (${params.before}::date + interval '1 day'))
    )
    SELECT
      id,
      feed_item_id,
      chunk_index,
      source_type,
      title,
      author_name,
      published_at,
      url,
      NULL::text AS snippet,
      text,
      entity_labels,
      local_rank AS fts_rank,
      NULL::integer AS vec_rank,
      NULL::double precision AS vec_distance,
      (1.0::double precision / (${HYBRID_MEMORY_RANK_CONSTANT} + local_rank)) AS rrf_score
    FROM ranked
    WHERE local_rank <= ${limitPerItem}
    ORDER BY
      array_position(${feedItemIds}::int[], feed_item_id),
      local_rank ASC,
      id ASC
  `;

  const allowedFeedItemIds = new Set(feedItemIds);
  return asRows<MemorySearchChunkRow>(rows).filter((row) =>
    allowedFeedItemIds.has(row.feed_item_id),
  );
}

type PaperEvidenceFacetIntent =
  | "result_metric"
  | "benchmark_or_dataset"
  | "method"
  | "limitation"
  | "high_stakes_proof"
  | "generic";

function stripPaperCardPrefix(value: string): string {
  return value
    .replace(/^\s*paper card\s*:\s*/i, "")
    .replace(/^\s*title\s*:\s*.*?\babstract\s*:\s*/i, "Abstract: ")
    .trim();
}

function isWeakPaperSnippet(value: string | null | undefined): boolean {
  const normalized = normalizePlainText(value ?? "");
  return (
    !normalized ||
    normalized.includes("...") ||
    /^paper card\s*:/i.test(normalized) ||
    /^title\s*:/i.test(normalized)
  );
}

function splitEvidenceSentences(value: string): string[] {
  const cleaned = stripPaperCardPrefix(value)
    .replace(/\be\.g\./gi, "eg")
    .replace(/\bi\.e\./gi, "ie");
  return (
    cleaned.match(/[^.!?\n]+[.!?]+|[^.!?\n]+(?:\n|$)/g)?.map(normalizePlainText) ??
    []
  ).filter((sentence) => sentence.length >= 24);
}

function splitEvidenceSnippetCandidates(value: string): string[] {
  const cleaned = stripPaperCardPrefix(value);
  const sentences = splitEvidenceSentences(cleaned);
  const candidates: string[] = [];

  for (let index = 0; index < sentences.length; index += 1) {
    const sentence = sentences[index];
    candidates.push(sentence);
    for (const windowSize of [2, 3]) {
      const window = sentences.slice(index, index + windowSize);
      if (window.length !== windowSize) {
        continue;
      }
      const candidate = normalizePlainText(window.join(" "));
      if (candidate.length >= 24) {
        candidates.push(candidate);
      }
    }
  }

  if (candidates.length === 0 && cleaned) {
    candidates.push(cleaned);
  }

  return candidates
    .filter((candidate) => !isReferenceLikePaperEvidenceText(candidate))
    .slice(0, 72);
}

function classifyPaperEvidenceFacetIntents(
  query: string,
): PaperEvidenceFacetIntent[] {
  const lower = ` ${normalizePlainText(query).toLowerCase()} `;
  const intents: PaperEvidenceFacetIntent[] = [];

  if (
    /\b(?:clinical|patient|patients|diagnos(?:e|is|tic)|dosage|dose|medical|legal|safety|safe|autonomous|unsupervised|proof|prove|guarantee|guarantees)\b/.test(
      lower,
    )
  ) {
    intents.push("high_stakes_proof");
  }
  if (
    /\b(?:limitation|limitations|limit|limits|fail|fails|failed|failure|collapse|gap|cannot|can't|not enough|unsafe|risk|overclaim|overclaims|does not|do not|did not|only|still|mitigation|mitigations)\b/.test(
      lower,
    )
  ) {
    intents.push("limitation");
  }
  if (
    /\b(?:result|results|score|scores|accuracy|success rate|pass rate|recall|metric|metrics|performance|percent|percentage|%|how well|leaderboard|wins?|tool calls?|hours?|frames?|cases?|questions?|tasks?|specialties|x)\b/.test(
      lower,
    )
  ) {
    intents.push("result_metric");
  }
  if (
    /\b(?:benchmark|benchmarks|dataset|datasets|task|tasks|test|tests|tested|evaluat(?:e|es|ed|ing|ion)|suite|setup|scale|question|questions|case|cases|session|sessions|ability|abilities|environment|environments|trajectory|trajectories|long-horizon|real-world|video|videos|frame|frames)\b/.test(
      lower,
    )
  ) {
    intents.push("benchmark_or_dataset");
  }
  if (
    /\b(?:method|methods|propos(?:e|es|ed)|introduc(?:e|es|ed)|uses?|using|framework|retrieval|memory|architecture|planner|policy|training|action space|graph|api|apis|tool-use|tools?)\b/.test(
      lower,
    )
  ) {
    intents.push("method");
  }

  return intents.length > 0 ? intents : ["generic"];
}

function patternMatchCount(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0;
}

function scorePaperEvidenceConcreteness(value: string): number {
  const text = normalizePlainText(value);
  const lower = text.toLowerCase();
  let score = 0;

  const numericSignals = lower.match(
    /\b\d[\d,.]*(?:\s?(?:%|x|k|m|b)|-\d[\d,.]*(?:\s?(?:%|x|k|m|b))?)?\b/g,
  );
  score += Math.min(numericSignals?.length ?? 0, 4) * 1.5;

  const detailPatterns = [
    /\b(?:benchmark|evaluat(?:e|es|ed|ing|ion)|test(?:s|ed|ing)?|task(?:s)?|question(?:s)?|case(?:s)?|dataset(?:s)?|tool(?:s)?|api(?:s)?|environment(?:s)?|trajectory|trajectories|frame(?:s)?|token(?:s)?|session(?:s)?|ability|abilities|specialt(?:y|ies))\b/,
    /\b(?:comprises|comprising|contains?|includes?|curated?|constructed?|spanning|across|adapted from|built from|grounded in|accessed through|paired with|exposes?|measures?)\b/,
    /\b(?:accuracy|success rate|pass rate|recall|latency|cost|tool calls?|evidence recall|score|scores|percent|percentage)\b/,
    /\b(?:first|only|best|frontier|real-world|long-horizon|multi-step|multi-session|multi-modal|multimodal)\b/,
  ];
  score += detailPatterns.filter((pattern) => pattern.test(lower)).length * 1.25;

  if (/\b(?:eg|for example|such as)\b/.test(lower)) {
    score += 1.25;
  }
  if (/\([A-Z][A-Z0-9-]{1,}\)/.test(text)) {
    score += 1;
  }
  if ((text.match(/,/g)?.length ?? 0) >= 3 || text.includes(";")) {
    score += 1;
  }

  return Math.min(score, 9);
}

function scorePaperEvidenceFacetSignals(
  profile: EvidenceClaimProfile,
  value: string,
): number {
  const lower = ` ${normalizePlainText(value).toLowerCase()} `;
  const intents = classifyPaperEvidenceFacetIntents(profile.query);
  const hasNumber = /\b\d[\d,.]*(?:\s?(?:%|percent|x|k|m|b))?\b/.test(lower);
  let score = 0;

  if (intents.includes("result_metric")) {
    const metricMatches = patternMatchCount(
      lower,
      /\b(?:accuracy|success rate|pass rate|recall|precision|f1|auc|score|scores|metric|metrics|result|results|percent|percentage|performance|tool calls?|hours?|frames?|tasks?|questions?|cases?|specialties|play@\d|exec@\d)\b|%/g,
    );
    score += Math.min(metricMatches, 5) * 1.5;
    if (hasNumber && metricMatches > 0) {
      score += 5;
    }
  }

  if (intents.includes("benchmark_or_dataset")) {
    const setupMatches = patternMatchCount(
      lower,
      /\b(?:benchmark|benchmarks|dataset|datasets|task|tasks|question|questions|case|cases|session|sessions|ability|abilities|environment|environments|suite|setup|scale|evaluat(?:e|es|ed|ing|ion)|test(?:s|ed|ing)?|trajectory|trajectories|video|videos|frame|frames|hour|hours|specialt(?:y|ies)|long-horizon|real-world)\b/g,
    );
    score += Math.min(setupMatches, 6) * 1.25;
    if (hasNumber && setupMatches > 0) {
      score += 4;
    }
  }

  if (intents.includes("method")) {
    const methodMatches = patternMatchCount(
      lower,
      /\b(?:method|methods|propos(?:e|es|ed)|introduc(?:e|es|ed)|uses?|using|framework|retrieval|memory|architecture|planner|policy|training|action space|graph|api|apis|tool-use|tools?|agent loop|workflow)\b/g,
    );
    score += Math.min(methodMatches, 5) * 1.25;
  }

  if (intents.includes("limitation")) {
    const limitationMatches = patternMatchCount(
      lower,
      /\b(?:limitation|limitations|limit|limits|fail|fails|failed|failure|collapse|gap|cannot|can't|not enough|unsafe|risk|overclaim|does not|do not|did not|only|still|mitigation|mitigations|however|but)\b/g,
    );
    score += Math.min(limitationMatches, 5) * 2;
    if (limitationMatches > 0 && hasNumber) {
      score += 2;
    }
  }

  return Math.min(score, 14);
}

function scorePaperEvidenceText(
  profile: EvidenceClaimProfile,
  value: string | null | undefined,
  plan?: PaperEvidenceFacetPlan,
  feedItemId?: number,
): number {
  const text = normalizePlainText(value ?? "");
  if (!text || isReferenceLikePaperEvidenceText(text)) {
    return 0;
  }

  const claimScore = scoreEvidenceChunkForClaim(profile, text).score;
  const facetScore = scorePaperEvidenceFacetSignals(profile, text);
  const plannedFacetScore = scorePaperEvidencePlannedFacetSignals(
    plan,
    text,
    feedItemId,
  );
  if (claimScore <= 0 && facetScore <= 0 && plannedFacetScore <= 0) {
    return 0;
  }

  const concreteness = scorePaperEvidenceConcreteness(text);
  return (
    claimScore +
    facetScore +
    plannedFacetScore +
    (claimScore > 0 || plannedFacetScore > 0
      ? concreteness
      : Math.min(concreteness, 5))
  );
}

function buildCompositeEvidenceSnippetCandidate(
  profile: EvidenceClaimProfile,
  text: string | null | undefined,
  plan?: PaperEvidenceFacetPlan,
  feedItemId?: number,
): string | null {
  const scoredSentences = splitEvidenceSentences(text ?? "")
    .map((sentence, index) => ({
      sentence,
      index,
      score: scorePaperEvidenceText(profile, sentence, plan, feedItemId),
    }))
    .filter(({ score, sentence }) => {
      return score > 0 && !isReferenceLikePaperEvidenceText(sentence);
    })
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return a.index - b.index;
    });

  const selected: typeof scoredSentences = [];
  for (const candidate of scoredSentences) {
    const ordered = [...selected, candidate].sort((a, b) => a.index - b.index);
    const value = ordered.map(({ sentence }) => sentence).join(" ... ");
    if (value.length > MAX_PAPER_EVIDENCE_SNIPPET_CHARS && selected.length > 0) {
      continue;
    }
    selected.push(candidate);
    if (selected.length >= 4) {
      break;
    }
  }

  if (selected.length < 2) {
    return null;
  }

  const composite = selected
    .sort((a, b) => a.index - b.index)
    .map(({ sentence }) => sentence)
    .join(" ... ");

  return truncateAtBoundary(composite, MAX_PAPER_EVIDENCE_SNIPPET_CHARS);
}

export function selectPaperEvidenceSnippetFromText(
  profile: EvidenceClaimProfile,
  text: string | null | undefined,
  plan?: PaperEvidenceFacetPlan,
  feedItemId?: number,
): string | null {
  const candidates = [
    ...splitEvidenceSnippetCandidates(text ?? ""),
    buildCompositeEvidenceSnippetCandidate(profile, text, plan, feedItemId),
  ].filter((candidate): candidate is string => Boolean(candidate));
  if (candidates.length === 0) {
    return null;
  }

  const [best] = candidates
    .map((candidate, index) => ({
      candidate,
      index,
      score: scorePaperEvidenceText(profile, candidate, plan, feedItemId),
    }))
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return a.index - b.index;
    });

  if (!best || best.score <= 0) {
    return null;
  }

  return truncateAtBoundary(best.candidate, MAX_PAPER_EVIDENCE_SNIPPET_CHARS);
}

function withPaperEvidenceSnippet(
  row: MemorySearchChunkRow,
  profile: EvidenceClaimProfile,
  plan?: PaperEvidenceFacetPlan,
): MemorySearchChunkRow {
  if (row.source_type !== "paper" || !row.text) {
    return row;
  }

  const bestSnippet = selectPaperEvidenceSnippetFromText(
    profile,
    row.text,
    plan,
    row.feed_item_id,
  );
  if (!bestSnippet) {
    return row;
  }

  const currentScore = scorePaperEvidenceText(
    profile,
    row.snippet,
    plan,
    row.feed_item_id,
  );
  const bestScore = scorePaperEvidenceText(
    profile,
    bestSnippet,
    plan,
    row.feed_item_id,
  );
  if (!isWeakPaperSnippet(row.snippet) && bestScore <= currentScore) {
    return row;
  }

  return {
    ...row,
    snippet: bestSnippet,
  };
}

function selectPaperLocalEvidenceRows({
  query,
  feedItemIds,
  rows,
  plan = buildPaperEvidenceFacetPlan(query, feedItemIds),
}: {
  query: string;
  feedItemIds: number[];
  rows: MemorySearchChunkRow[];
  plan?: PaperEvidenceFacetPlan;
}): MemorySearchChunkRow[] {
  const profile = buildEvidenceClaimProfile(
    query,
    buildPaperEvidenceQueries(query, plan),
  );
  const selected: MemorySearchChunkRow[] = [];

  for (const feedItemId of feedItemIds) {
    const plannedEntry = plan?.entries.find(
      ({ entry }) => entry.feedItemId === feedItemId,
    );
    const plannedEvidenceRows = plannedEntry
      ? rows
          .filter((row) => row.feed_item_id === feedItemId)
          .map((row, index) => {
            const rowText = [row.snippet, row.text, row.title]
              .filter(Boolean)
              .join(" ");
            const exactPhraseMatches = plannedEntry.entry.evidencePhrases.filter(
              (phrase) =>
                paperEvidenceTextContainsPhrase(
                  normalizePaperEvidenceAnchor(rowText),
                  phrase,
                ),
            ).length;
            if (exactPhraseMatches === 0) {
              return null;
            }
            const snippetRow = withPaperEvidenceSnippet(row, profile, plan);
            const evidenceScore = scorePaperEvidenceText(
              profile,
              [snippetRow.snippet, snippetRow.text].filter(Boolean).join(" "),
              plan,
              snippetRow.feed_item_id,
            );
            return {
              row: snippetRow,
              index,
              exactPhraseMatches,
              evidenceScore,
            };
          })
          .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
          .sort((a, b) => {
            if (b.exactPhraseMatches !== a.exactPhraseMatches) {
              return b.exactPhraseMatches - a.exactPhraseMatches;
            }
            if (b.evidenceScore !== a.evidenceScore) {
              return b.evidenceScore - a.evidenceScore;
            }
            const aChunkIndex =
              normalizeOptionalNumber(a.row.chunk_index) ??
              Number.POSITIVE_INFINITY;
            const bChunkIndex =
              normalizeOptionalNumber(b.row.chunk_index) ??
              Number.POSITIVE_INFINITY;
            if (aChunkIndex !== bChunkIndex) {
              return aChunkIndex - bChunkIndex;
            }
            return a.index - b.index;
          })
          .slice(0, 2)
          .map((entry) => entry.row)
      : [];
    const scoredRows = rows
      .filter((row) => row.feed_item_id === feedItemId)
      .map((row, index) => {
        const snippetRow = withPaperEvidenceSnippet(row, profile, plan);
        const evidenceScore = scorePaperEvidenceText(
          profile,
          [snippetRow.snippet, snippetRow.text].filter(Boolean).join(" "),
          plan,
          snippetRow.feed_item_id,
        );
        return {
          row: snippetRow,
          index,
          evidenceScore,
          weakSnippet: isWeakPaperSnippet(snippetRow.snippet),
        };
      })
      .sort((a, b) => {
        if (a.weakSnippet !== b.weakSnippet) {
          return a.weakSnippet ? 1 : -1;
        }
        if (b.evidenceScore !== a.evidenceScore) {
          return b.evidenceScore - a.evidenceScore;
        }

        const aFtsRank = normalizeOptionalNumber(a.row.fts_rank) ?? Number.POSITIVE_INFINITY;
        const bFtsRank = normalizeOptionalNumber(b.row.fts_rank) ?? Number.POSITIVE_INFINITY;
        if (aFtsRank !== bFtsRank) {
          return aFtsRank - bFtsRank;
        }

        return a.index - b.index;
      })
      .slice(0, PAPER_EVIDENCE_LOCAL_SNIPPETS_PER_ITEM);

    const selectedForPaper = mergePaperEvidenceRowsById([
      ...plannedEvidenceRows,
      ...scoredRows.map((entry) => entry.row),
    ]).slice(0, PAPER_EVIDENCE_LOCAL_SNIPPETS_PER_ITEM);

    selected.push(...selectedForPaper);
  }

  return selected;
}

function paperEvidenceVerifierText(
  hit: MemorySearchChunkHit & { text?: string | null },
): string {
  return normalizePlainText(
    [hit.title, hit.snippet, hit.text, ...(hit.entity_labels ?? [])]
      .filter(Boolean)
      .join(" "),
  );
}

function toPaperEvidenceDebugChunk(
  chunk: ReturnType<typeof verifyPaperEvidenceChunks>["chunks"][number],
): PaperEvidenceDebugChunk {
  const hit = chunk.hit;
  return {
    chunk_id: hit.id,
    feed_item_id: hit.feed_item_id,
    title: hit.title,
    chunk_index: hit.chunk_index ?? null,
    verifier_evidence_text: truncateAtBoundary(
      paperEvidenceVerifierText(hit),
      MAX_PAPER_EVIDENCE_DEBUG_TEXT_CHARS,
    ),
    returned_snippet: hit.snippet,
    matched_terms: chunk.matchedTerms,
    matched_numbers: chunk.matchedNumbers,
    matched_anchor_groups: chunk.matchedAnchorGroups,
    missing_anchor_groups: chunk.missingAnchorGroups,
    anchor_groups_by_kind: chunk.anchorGroupsByKind,
    identity_anchor_matches: chunk.identityAnchorMatches,
    claim_detail_anchor_matches: chunk.claimDetailAnchorMatches,
    demotion_reason: chunk.demotionReason,
    is_reference_like: chunk.isReferenceLike,
    is_paper_card: chunk.isPaperCard,
    supports: chunk.supports,
    reason: chunk.reason,
  };
}

function mergePaperEvidenceRowsById(
  rows: MemorySearchChunkRow[],
): MemorySearchChunkRow[] {
  const rowsById = new Map<string, MemorySearchChunkRow>();
  for (const row of rows) {
    const key =
      row.paper_evidence?.span_id == null
        ? String(row.id)
        : `${row.id}:span:${row.paper_evidence.span_id}`;
    const existing = rowsById.get(key);
    if (!existing) {
      rowsById.set(key, row);
      continue;
    }

    const existingSnippetWeak = isWeakPaperSnippet(existing.snippet);
    const rowSnippetWeak = isWeakPaperSnippet(row.snippet);
    if (existingSnippetWeak && !rowSnippetWeak) {
      rowsById.set(key, {
        ...existing,
        ...row,
        text: row.text ?? existing.text,
      });
    }
  }
  return [...rowsById.values()];
}

function supportingSnippetsContainPlannedEvidence(
  verification: ReturnType<typeof verifyPaperEvidenceChunks>,
  plan: PaperEvidenceFacetPlan,
): boolean {
  if (plan.exactEvidencePhrases.length === 0) {
    return true;
  }

  const supportingSnippets = verification.chunks
    .filter((chunk) => chunk.supports)
    .map((chunk) => normalizePaperEvidenceAnchor(chunk.hit.snippet ?? ""))
    .join("\n");

  return plan.exactEvidencePhrases.some((phrase) =>
    paperEvidenceTextContainsPhrase(supportingSnippets, phrase),
  );
}

function paperEvidenceRepairQueries(
  plan: PaperEvidenceFacetPlan,
  verification: ReturnType<typeof verifyPaperEvidenceChunks>,
): string[] {
  return uniquePaperEvidencePhrases([
    ...plan.exactEvidencePhrases,
    ...verification.chunks.flatMap((chunk) => chunk.missingAnchorGroups),
    ...plan.queryFacets,
  ]).slice(0, PAPER_EVIDENCE_GRAPH_QUERY_LIMIT);
}

function candidateIdsFromEvidenceGraphPlan(
  plan: PaperEvidenceFacetPlan,
  limit: number,
): number[] {
  const topScore = plan.entries[0]?.queryScore ?? 0;
  if (topScore < PAPER_EVIDENCE_FAST_GRAPH_MIN_SCORE) {
    return [];
  }
  return [
    ...new Set(plan.entries.map(({ entry }) => entry.feedItemId)),
  ].slice(0, limit);
}

async function queryFastPaperEvidenceCandidateIds(
  normalized: Required<SearchMemoryForToolParams>,
  limit: number,
): Promise<number[]> {
  const exactTerms = extractSignificantExactTerms(normalized.query);
  const highSignalTerms = extractHighSignalExactTerms(normalized.query);
  const feedItemRows = await queryMemoryFeedItemCandidateRows(
    normalized,
    exactTerms,
    highSignalTerms,
    limit,
  );
  return [
    ...new Set(feedItemRows.map((row) => row.feed_item_id)),
  ].slice(0, limit);
}

type PaperEvidenceSearchAttempt = {
  evidenceHits: Array<
    MemorySearchChunkHit & { text?: string | null; chunk_index?: number | null }
  >;
  verification: ReturnType<typeof verifyPaperEvidenceChunks>;
};

async function runPaperEvidenceSearchForCandidateIds({
  normalized,
  candidateFeedItemIds,
  plan,
  queryEmbedding,
}: {
  normalized: Required<SearchMemoryForToolParams>;
  candidateFeedItemIds: number[];
  plan: PaperEvidenceFacetPlan;
  queryEmbedding?: number[] | null;
}): Promise<PaperEvidenceSearchAttempt> {
  const [evidenceLayerRows, localChunkRows, graphSearchRows] = await Promise.all([
    queryPaperEvidenceLayerRowsForCandidatePapers({
      normalized,
      feedItemIds: candidateFeedItemIds,
      plan,
      queryEmbedding,
    }),
    queryPaperLocalChunksForFeedItems(normalized, candidateFeedItemIds),
    queryPaperEvidenceRowsForCandidatePapers({
      normalized,
      feedItemIds: candidateFeedItemIds,
      plan,
    }),
  ]);
  const legacyCandidateRows = mergePaperEvidenceRowsById([
    ...localChunkRows,
    ...graphSearchRows,
  ]);
  const paperCandidateRows = mergePaperEvidenceRowsById([
    ...evidenceLayerRows,
    ...legacyCandidateRows,
  ]);

  const selectAndVerify = (
    rows: MemorySearchChunkRow[],
  ): PaperEvidenceSearchAttempt => {
    const evidenceRows = selectPaperLocalEvidenceRows({
      query: normalized.query,
      feedItemIds: candidateFeedItemIds,
      rows,
      plan,
    });
    const evidenceHits = evidenceRows
      .map((row) => ({
        ...mapSearchChunkRow(row),
        text: normalizePlainText(row.text ?? ""),
        chunk_index: row.chunk_index,
      }))
      .filter((hit) => hit.snippet);
    const verification = verifyPaperEvidenceChunks({
      query: normalized.query,
      candidateFeedItemIds,
      hits: evidenceHits,
    });
    return { evidenceHits, verification };
  };

  let attempt = selectAndVerify(paperCandidateRows);
  let evidenceHits = attempt.evidenceHits;
  let verification = attempt.verification;

  if (
    evidenceLayerRows.length > 0 &&
    verification.metadata.status !== "supports"
  ) {
    const legacyAttempt = selectAndVerify(legacyCandidateRows);
    if (legacyAttempt.verification.metadata.status === "supports") {
      evidenceHits = legacyAttempt.evidenceHits;
      verification = legacyAttempt.verification;
    }
  }

  if (
    verification.metadata.status === "paper_related_only" ||
    (verification.metadata.status === "supports" &&
      !supportingSnippetsContainPlannedEvidence(verification, plan))
  ) {
    const repairQueries = paperEvidenceRepairQueries(plan, verification);
    const [repairLayerRows, repairRows] = await Promise.all([
      queryPaperEvidenceLayerRowsForCandidatePapers({
        normalized,
        feedItemIds: candidateFeedItemIds,
        plan,
        queryEmbedding,
        query: repairQueries.join(" "),
      }),
      queryPaperEvidenceRowsForCandidatePapers({
        normalized,
        feedItemIds: candidateFeedItemIds,
        plan,
        evidenceQueries: repairQueries,
      }),
    ]);
    attempt = selectAndVerify(
      mergePaperEvidenceRowsById([
        ...paperCandidateRows,
        ...repairLayerRows,
        ...repairRows,
      ]),
    );
    evidenceHits = attempt.evidenceHits;
    verification = attempt.verification;

    if (
      repairLayerRows.length > 0 &&
      verification.metadata.status !== "supports"
    ) {
      const legacyAttempt = selectAndVerify(
        mergePaperEvidenceRowsById([...legacyCandidateRows, ...repairRows]),
      );
      if (legacyAttempt.verification.metadata.status === "supports") {
        evidenceHits = legacyAttempt.evidenceHits;
        verification = legacyAttempt.verification;
      }
    }
  }

  return { evidenceHits, verification };
}

function toPublicSearchChunkHit(
  hit: MemorySearchChunkHit & {
    chunk_index?: number | null;
  },
): MemorySearchChunkHit {
  const publicHit = { ...hit };
  delete publicHit.chunk_index;
  return publicHit;
}

function paperEvidenceHitKey(
  hit: MemorySearchChunkHit & { text?: string | null },
): string {
  return [
    hit.id,
    hit.paper_evidence?.span_id ?? "",
    normalizePlainText(hit.snippet).slice(0, 160),
  ].join(":");
}

export interface MemoryParentCandidate {
  feed_item_id: number;
  source_type: FeedItemSourceType;
  score: number;
  first_rank: number;
  exact_token_matches: number;
  exact_token_count: number;
  high_signal_token_matches: number;
  high_signal_token_count: number;
}

function countExactTermMatchesInText(text: string, exactTerms: string[]): number {
  if (exactTerms.length === 0) {
    return 0;
  }
  const normalized = ` ${text
    .toLowerCase()
    .replace(/[^a-z0-9+#]+/g, " ")} `;
  return exactTerms.filter((term) => normalized.includes(` ${term} `)).length;
}

function memorySourceTypeFactor(
  sourceType: FeedItemSourceType,
  intent: MemoryQueryIntent,
  requestedSource: MemorySearchSource,
): number {
  if (
    sourceType === "podcast" &&
    (intent === "metadata" || requestedSource === "podcast")
  ) {
    return 1.2;
  }

  switch (sourceType) {
    case "tweet":
      return 1.15;
    case "paper":
      return 1.0;
    case "newsletter":
      return 0.95;
    case "podcast":
      return 0.85;
  }
}

function exactTokenCoverageBoost(matches: number, count: number): number {
  if (matches <= 0 || count <= 0) {
    return 1;
  }

  const coverage = matches / count;
  return 1 + Math.min(0.75, coverage * 0.5 + Math.min(matches, 8) * 0.035);
}

function attributionExactContentBoost(
  parent: {
    source_type: FeedItemSourceType;
    high_signal_token_matches: number;
    exact_token_matches: number;
    content_match: boolean;
  },
  intent: MemoryQueryIntent,
): number {
  if (intent !== "attribution" || !parent.content_match) {
    return 1;
  }

  if (parent.source_type === "tweet" && parent.high_signal_token_matches >= 2) {
    return 1.35;
  }

  if (parent.high_signal_token_matches >= 2 || parent.exact_token_matches >= 4) {
    return 1.15;
  }

  return 1;
}

function workspaceProactiveFactor(
  parent: {
    workspace_context_matches: number;
    proactive_match: boolean;
  },
  exactTerms: string[],
): number {
  const exactTermSet = new Set(exactTerms);
  const workspaceIntent =
    (exactTermSet.has("email") ||
      exactTermSet.has("calendar") ||
      exactTermSet.has("gmail") ||
      exactTermSet.has("workspace")) &&
    (exactTermSet.has("proactive") ||
      exactTermSet.has("proactively") ||
      exactTermSet.has("waiting") ||
      exactTermSet.has("instructions"));

  if (!workspaceIntent) {
    return 1;
  }

  if (parent.proactive_match && parent.workspace_context_matches >= 2) {
    return 4;
  }

  if (!parent.proactive_match) {
    return 0.2;
  }

  return 1;
}

export function rankMemoryParentCandidates({
  chunkRows,
  feedItemRows,
  exactTerms,
  highSignalTerms = [],
  intent,
  source,
  limit,
}: {
  chunkRows: MemorySearchChunkRow[];
  feedItemRows: MemoryFeedItemCandidateRow[];
  exactTerms: string[];
  highSignalTerms?: string[];
  intent: MemoryQueryIntent;
  source: MemorySearchSource;
  limit: number;
}): MemoryParentCandidate[] {
  const parents = new Map<
    number,
    {
      feed_item_id: number;
      source_type: FeedItemSourceType;
      baseScore: number;
      first_rank: number;
      exact_token_matches: number;
      exact_token_count: number;
      high_signal_token_matches: number;
      high_signal_token_count: number;
      title_match: boolean;
      content_match: boolean;
      workspace_context_matches: number;
      proactive_match: boolean;
    }
  >();

  chunkRows.forEach((row, index) => {
    const rank = index + 1;
    const metadataText = [
      row.title,
      row.author_name,
      row.source_type,
      row.text,
      ...(row.entity_labels ?? []),
    ]
      .filter(Boolean)
      .join(" ");
    const exactMatches = countExactTermMatchesInText(metadataText, exactTerms);
    const highSignalMatches = countExactTermMatchesInText(
      metadataText,
      highSignalTerms,
    );
    const workspaceContextMatches = countExactTermMatchesInText(metadataText, [
      "email",
      "calendar",
      "gmail",
      "google",
      "workspace",
      "docs",
    ]);
    const proactiveMatch = countExactTermMatchesInText(metadataText, [
      "proactive",
      "proactively",
    ]) > 0;
    const existing = parents.get(row.feed_item_id);
    const score =
      MEMORY_PARENT_CHUNK_WEIGHT /
      (HYBRID_MEMORY_RANK_CONSTANT + rank);

    if (existing) {
      existing.baseScore += score * 0.15;
      existing.exact_token_matches = Math.max(
        existing.exact_token_matches,
        exactMatches,
      );
      existing.exact_token_count = Math.max(
        existing.exact_token_count,
        exactTerms.length,
      );
      existing.high_signal_token_matches = Math.max(
        existing.high_signal_token_matches,
        highSignalMatches,
      );
      existing.high_signal_token_count = Math.max(
        existing.high_signal_token_count,
        highSignalTerms.length,
      );
      existing.content_match = existing.content_match || exactMatches > 0;
      existing.workspace_context_matches = Math.max(
        existing.workspace_context_matches,
        workspaceContextMatches,
      );
      existing.proactive_match = existing.proactive_match || proactiveMatch;
      existing.first_rank = Math.min(existing.first_rank, rank);
      return;
    }

    parents.set(row.feed_item_id, {
      feed_item_id: row.feed_item_id,
      source_type: row.source_type,
      baseScore: score,
      first_rank: rank,
      exact_token_matches: exactMatches,
      exact_token_count: exactTerms.length,
      high_signal_token_matches: highSignalMatches,
      high_signal_token_count: highSignalTerms.length,
      title_match: false,
      content_match: exactMatches > 0,
      workspace_context_matches: workspaceContextMatches,
      proactive_match: proactiveMatch,
    });
  });

  feedItemRows.forEach((row, index) => {
    const rank = normalizeOptionalInteger(row.item_rank) || index + 1;
    const existing = parents.get(row.feed_item_id);
    const exactMatches = normalizeOptionalInteger(row.exact_token_matches);
    const exactCount = normalizeOptionalInteger(row.exact_token_count);
    const highSignalMatches = normalizeOptionalInteger(
      row.high_signal_token_matches,
    );
    const highSignalCount = normalizeOptionalInteger(row.high_signal_token_count);
    const exactCoverage = exactCount > 0 ? exactMatches / exactCount : 0;
    const highSignalCoverage =
      highSignalCount > 0 ? highSignalMatches / highSignalCount : 0;
    const semanticFeedItemFactor =
      intent === "semantic"
        ? Math.max(0.2, exactCoverage, highSignalCoverage)
        : 1;
    const score =
      (MEMORY_PARENT_FEED_ITEM_WEIGHT * semanticFeedItemFactor) /
      (HYBRID_MEMORY_RANK_CONSTANT + rank);

    if (existing) {
      existing.baseScore += score;
      existing.exact_token_matches = Math.max(
        existing.exact_token_matches,
        exactMatches,
      );
      existing.exact_token_count = Math.max(existing.exact_token_count, exactCount);
      existing.high_signal_token_matches = Math.max(
        existing.high_signal_token_matches,
        highSignalMatches,
      );
      existing.high_signal_token_count = Math.max(
        existing.high_signal_token_count,
        highSignalCount,
      );
      existing.title_match = existing.title_match || row.title_match === true;
      existing.content_match =
        existing.content_match || row.content_match === true;
      existing.first_rank = Math.min(existing.first_rank, rank);
      return;
    }

    parents.set(row.feed_item_id, {
      feed_item_id: row.feed_item_id,
      source_type: row.source_type,
      baseScore: score,
      first_rank: rank,
      exact_token_matches: exactMatches,
      exact_token_count: exactCount,
      high_signal_token_matches: highSignalMatches,
      high_signal_token_count: highSignalCount,
      title_match: row.title_match === true,
      content_match: row.content_match === true,
      workspace_context_matches: 0,
      proactive_match: false,
    });
  });

  return [...parents.values()]
    .filter((parent) => {
      if (
        parent.high_signal_token_count >= 2 &&
        parent.high_signal_token_matches < 2
      ) {
        return false;
      }

      if (
        parent.high_signal_token_count === 1 &&
        parent.exact_token_count >= 4 &&
        parent.exact_token_matches < 3
      ) {
        return false;
      }

      if (
        parent.exact_token_count >= 4 &&
        parent.exact_token_matches < 2 &&
        parent.high_signal_token_matches === 0
      ) {
        return false;
      }

      return true;
    })
    .map((parent) => {
      const titleOnlyPodcastFactor =
        intent === "semantic" &&
        parent.source_type === "podcast" &&
        parent.title_match &&
        !parent.content_match
          ? MEMORY_PARENT_TITLE_ONLY_PODCAST_SEMANTIC_FACTOR
          : 1;
      const exactCoverage =
        parent.exact_token_count > 0
          ? parent.exact_token_matches / parent.exact_token_count
          : 0;
      const lowCoverageSemanticFactor =
        intent === "semantic" &&
        parent.exact_token_count > 0 &&
        exactCoverage < 0.35
          ? 0.6
          : 1;
      const broadContainerSemanticFactor =
        intent === "semantic" &&
        (parent.source_type === "podcast" || parent.source_type === "newsletter") &&
        !parent.content_match
          ? MEMORY_PARENT_BROAD_CONTAINER_SEMANTIC_FACTOR
          : 1;
      const highSignalBoost =
        parent.high_signal_token_matches > 0
          ? 1 + Math.min(1, parent.high_signal_token_matches * 0.25)
          : 1;
      const score =
        parent.baseScore *
        memorySourceTypeFactor(parent.source_type, intent, source) *
        exactTokenCoverageBoost(
          parent.exact_token_matches,
          parent.exact_token_count,
        ) *
        titleOnlyPodcastFactor *
        lowCoverageSemanticFactor *
        broadContainerSemanticFactor *
        workspaceProactiveFactor(parent, exactTerms) *
        highSignalBoost *
        attributionExactContentBoost(parent, intent);

      return {
        feed_item_id: parent.feed_item_id,
        source_type: parent.source_type,
        score,
        first_rank: parent.first_rank,
        exact_token_matches: parent.exact_token_matches,
        exact_token_count: parent.exact_token_count,
        high_signal_token_matches: parent.high_signal_token_matches,
        high_signal_token_count: parent.high_signal_token_count,
      };
    })
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      if (a.first_rank !== b.first_rank) {
        return a.first_rank - b.first_rank;
      }
      return a.feed_item_id - b.feed_item_id;
    })
    .slice(0, limit);
}

function selectParentAwareChunkRows({
  parentCandidates,
  chunkRows,
  evidenceRows,
  limit,
}: {
  parentCandidates: MemoryParentCandidate[];
  chunkRows: MemorySearchChunkRow[];
  evidenceRows: MemorySearchChunkRow[];
  limit: number;
}): MemorySearchChunkRow[] {
  const chunkRankById = new Map(chunkRows.map((row, index) => [row.id, index + 1]));
  const rowsByFeedItemId = new Map<number, Map<number, MemorySearchChunkRow>>();

  for (const row of [...chunkRows, ...evidenceRows]) {
    const byId = rowsByFeedItemId.get(row.feed_item_id) ?? new Map();
    const existing = byId.get(row.id);
    if (!existing || chunkRankById.has(row.id)) {
      byId.set(row.id, row);
    }
    rowsByFeedItemId.set(row.feed_item_id, byId);
  }

  const selected: MemorySearchChunkRow[] = [];
  for (const parent of parentCandidates) {
    const rows = [...(rowsByFeedItemId.get(parent.feed_item_id)?.values() ?? [])]
      .sort((a, b) => {
        const aChunkRank = chunkRankById.get(a.id) ?? Number.POSITIVE_INFINITY;
        const bChunkRank = chunkRankById.get(b.id) ?? Number.POSITIVE_INFINITY;
        if (aChunkRank !== bChunkRank) {
          return aChunkRank - bChunkRank;
        }

        const aScore = normalizeOptionalNumber(a.rrf_score) ?? 0;
        const bScore = normalizeOptionalNumber(b.rrf_score) ?? 0;
        if (bScore !== aScore) {
          return bScore - aScore;
        }

        const aFtsRank = normalizeOptionalNumber(a.fts_rank) ?? Number.POSITIVE_INFINITY;
        const bFtsRank = normalizeOptionalNumber(b.fts_rank) ?? Number.POSITIVE_INFINITY;
        if (aFtsRank !== bFtsRank) {
          return aFtsRank - bFtsRank;
        }

        return a.id - b.id;
      })
      .slice(0, MEMORY_PARENT_EVIDENCE_CHUNKS_PER_ITEM);

    for (const row of rows) {
      selected.push(row);
      if (selected.length >= limit) {
        return selected;
      }
    }
  }

  return selected;
}

function prioritizeWorkspaceProactiveRows(
  rows: MemorySearchChunkRow[],
  exactTerms: string[],
): MemorySearchChunkRow[] {
  const exactTermSet = new Set(exactTerms);
  const workspaceIntent =
    (exactTermSet.has("email") ||
      exactTermSet.has("calendar") ||
      exactTermSet.has("gmail") ||
      exactTermSet.has("workspace")) &&
    (exactTermSet.has("proactive") || exactTermSet.has("proactively"));

  if (!workspaceIntent) {
    return rows;
  }

  return rows
    .map((row, index) => {
      const text = [
        row.title,
        row.author_name,
        row.source_type,
        row.text,
        ...(row.entity_labels ?? []),
      ]
        .filter(Boolean)
        .join(" ");
      const workspaceMatches = countExactTermMatchesInText(text, [
        "email",
        "calendar",
        "gmail",
        "google",
        "workspace",
        "docs",
      ]);
      const proactiveMatch =
        countExactTermMatchesInText(text, ["proactive", "proactively"]) > 0;
      const sourcePriority = row.source_type === "tweet" ? 1 : 0;
      return { row, index, workspaceMatches, proactiveMatch, sourcePriority };
    })
    .sort((a, b) => {
      if (a.proactiveMatch !== b.proactiveMatch) {
        return a.proactiveMatch ? -1 : 1;
      }
      if (b.sourcePriority !== a.sourcePriority) {
        return b.sourcePriority - a.sourcePriority;
      }
      if (b.workspaceMatches !== a.workspaceMatches) {
        return b.workspaceMatches - a.workspaceMatches;
      }
      return a.index - b.index;
    })
    .map((entry) => entry.row);
}

function prioritizeHeadlessSoftwareRows(
  rows: MemorySearchChunkRow[],
  exactTerms: string[],
): MemorySearchChunkRow[] {
  const exactTermSet = new Set(exactTerms);
  const headlessIntent =
    exactTermSet.has("software") &&
    (exactTermSet.has("headless") ||
      exactTermSet.has("apis") ||
      exactTermSet.has("platforms") ||
      exactTermSet.has("humans") ||
      exactTermSet.has("enterprise"));

  if (!headlessIntent) {
    return rows;
  }

  return rows
    .map((row, index) => {
      const text = [
        row.title,
        row.author_name,
        row.source_type,
        row.text,
        ...(row.entity_labels ?? []),
      ]
        .filter(Boolean)
        .join(" ");
      const headlessMatches = countExactTermMatchesInText(text, [
        "headless",
        "software",
        "agents",
        "agent",
        "apis",
        "api",
        "ui",
        "enterprise",
        "platforms",
        "platform",
        "humans",
        "people",
      ]);
      const sourceFactor =
        row.source_type === "tweet"
          ? 2
          : row.source_type === "paper"
            ? 1
            : 0;
      return {
        row,
        index,
        headlessScore: headlessMatches + sourceFactor,
      };
    })
    .sort((a, b) => {
      if (b.headlessScore !== a.headlessScore) {
        return b.headlessScore - a.headlessScore;
      }
      return a.index - b.index;
    })
    .map((entry) => entry.row);
}

async function retrieveParentAwareMemoryCandidatesForQuery(
  params: Required<SearchMemoryForToolParams>,
  limit: number,
  queryEmbedding?: number[] | null,
): Promise<MemorySearchChunkRow[]> {
  const intent = classifyMemoryQueryIntent(params.query);
  const exactTerms = extractSignificantExactTerms(params.query);
  const highSignalTerms = extractHighSignalExactTerms(params.query);
  let chunkRows: MemorySearchChunkRow[];
  let feedItemRows: MemoryFeedItemCandidateRow[];
  if (isMemoryVectorEnabled()) {
    chunkRows = await queryMemoryRowsForQuery(params, limit, queryEmbedding);
    feedItemRows = await queryMemoryFeedItemCandidateRows(
      params,
      exactTerms,
      highSignalTerms,
      limit,
    );
  } else {
    [chunkRows, feedItemRows] = await Promise.all([
      queryMemoryRowsForQuery(params, limit),
      queryMemoryFeedItemCandidateRows(
        params,
        exactTerms,
        highSignalTerms,
        limit,
      ),
    ]);
  }
  const parentCandidates = rankMemoryParentCandidates({
    chunkRows,
    feedItemRows,
    exactTerms,
    highSignalTerms,
    intent,
    source: params.source,
    limit,
  });
  const evidenceRows = await queryEvidenceChunksForFeedItems(
    params,
    parentCandidates.map((parent) => parent.feed_item_id),
    MEMORY_PARENT_EVIDENCE_CHUNKS_PER_ITEM,
  );

  const rows = selectParentAwareChunkRows({
    parentCandidates,
    chunkRows,
    evidenceRows,
    limit,
  });

  return prioritizeWorkspaceProactiveRows(
    prioritizeHeadlessSoftwareRows(rows, exactTerms),
    exactTerms,
  );
}

function countSearchTerms(query: string): number {
  return query.split(/\s+/).filter(Boolean).length;
}

function extractAnthropicText(response: { content: Array<{ type: string; text?: string }> }): string {
  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

function parseModelJson(raw: string): unknown {
  const normalized = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const candidates = [normalized];
  const firstObject = normalized.indexOf("{");
  const lastObject = normalized.lastIndexOf("}");
  if (firstObject !== -1 && lastObject > firstObject) {
    candidates.push(normalized.slice(firstObject, lastObject + 1));
  }
  const firstArray = normalized.indexOf("[");
  const lastArray = normalized.lastIndexOf("]");
  if (firstArray !== -1 && lastArray > firstArray) {
    candidates.push(normalized.slice(firstArray, lastArray + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next common wrapper shape.
    }
  }

  throw new Error("invalid JSON");
}

export type MemoryRerankScore = {
  id: number;
  score: number;
};

function parseMemoryRerankerPayload(
  raw: string,
  candidateIds: number[],
): { answerable?: boolean; scores: MemoryRerankScore[] } {
  let parsed: unknown;
  try {
    parsed = parseModelJson(raw);
  } catch {
    throw new Error("Memory reranker returned invalid JSON");
  }

  const answerable =
    typeof parsed === "object" &&
    parsed !== null &&
    typeof (parsed as { answerable?: unknown }).answerable === "boolean"
      ? (parsed as { answerable: boolean }).answerable
      : undefined;
  const scores = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { scores?: unknown }).scores)
      ? (parsed as { scores: unknown[] }).scores
      : null;

  if (!scores) {
    throw new Error("Memory reranker JSON must include a scores array");
  }

  const allowedIds = new Set(candidateIds);
  const seenIds = new Set<number>();
  const result: MemoryRerankScore[] = [];

  for (const item of scores) {
    if (typeof item !== "object" || item === null) {
      throw new Error("Memory reranker score entries must be objects");
    }
    const id = (item as { id?: unknown }).id;
    const score = (item as { score?: unknown }).score;
    if (
      typeof id !== "number" ||
      !Number.isInteger(id) ||
      !allowedIds.has(id) ||
      seenIds.has(id)
    ) {
      throw new Error("Memory reranker returned an unknown or duplicate id");
    }
    if (
      typeof score !== "number" ||
      !Number.isInteger(score) ||
      score < 0 ||
      score > 3
    ) {
      throw new Error("Memory reranker score must be an integer from 0 to 3");
    }
    seenIds.add(id);
    result.push({ id, score });
  }

  return { ...(answerable !== undefined ? { answerable } : {}), scores: result };
}

export function parseMemoryRerankerScores(
  raw: string,
  candidateIds: number[],
): MemoryRerankScore[] {
  return parseMemoryRerankerPayload(raw, candidateIds).scores;
}

export function parseMemoryQueryExpansions(
  raw: string,
  originalQuery: string,
): string[] {
  let parsed: unknown;
  try {
    parsed = parseModelJson(raw);
  } catch {
    throw new Error("Memory query expansion returned invalid JSON");
  }

  const queries = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { queries?: unknown }).queries)
      ? (parsed as { queries: unknown[] }).queries
      : null;

  if (!queries) {
    throw new Error("Memory query expansion JSON must include a queries array");
  }

  const normalizedOriginal = normalizePlainText(originalQuery);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const query of [normalizedOriginal, ...queries]) {
    if (typeof query !== "string") {
      continue;
    }
    const normalized = normalizePlainText(query);
    const key = normalized.toLocaleLowerCase();
    if (!normalized || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
    if (result.length >= MEMORY_EXPANSION_MAX_QUERIES) {
      break;
    }
  }

  return result;
}

function shouldExpandMemoryQuery(): boolean {
  return isMemoryRerankEnabled() && isMemoryQueryExpansionEnabled();
}

async function generateMemoryQueryExpansions(query: string): Promise<string[]> {
  if (!shouldExpandMemoryQuery() || countSearchTerms(query) < MEMORY_QUERY_EXPANSION_MIN_TERMS) {
    return [query];
  }

  const anthropic = new Anthropic();
  const response = await anthropic.messages.create({
    model: getMemoryRerankModel(),
    max_tokens: 512,
    temperature: 0,
    system:
      "Generate retrieval queries for a personal memory search index. Return only compact JSON with a queries array. Include a keyword/entity rewrite and a natural paraphrase. Do not add facts.",
    messages: [
      {
        role: "user",
        content: JSON.stringify({ query }),
      },
    ],
  });

  return parseMemoryQueryExpansions(extractAnthropicText(response), query);
}

async function queryMemoryRowsForQuery(
  params: Required<SearchMemoryForToolParams>,
  limit: number,
  queryEmbedding?: number[] | null,
): Promise<MemorySearchChunkRow[]> {
  if (isMemoryVectorEnabled()) {
    if (queryEmbedding !== undefined) {
      return queryEmbedding
        ? await queryHybridMemoryChunkRows(params, queryEmbedding, limit)
        : await queryMemoryChunkRows(params, limit);
    }
    try {
      const { embedding } = await embedMemoryText(params.query);
      return await queryHybridMemoryChunkRows(params, embedding, limit);
    } catch (error) {
      console.error("memory_retrieval.query_embedding_failed", {
        query: params.query,
        error: error instanceof Error ? error.message : String(error),
      });
      return await queryMemoryChunkRows(params, limit);
    }
  }

  return await queryMemoryChunkRows(params, limit);
}

export function mergeMemoryCandidateRowsByRrf(
  resultSets: Array<{ query: string; rows: MemorySearchChunkRow[] }>,
  limit: number,
): MemorySearchChunkRow[] {
  const merged = new Map<
    number,
    {
      row: MemorySearchChunkRow;
      score: number;
      firstRank: number;
      firstSet: number;
    }
  >();

  resultSets.forEach((resultSet, setIndex) => {
    resultSet.rows.forEach((row, rowIndex) => {
      const rank = rowIndex + 1;
      const score = 1 / (HYBRID_MEMORY_RANK_CONSTANT + rank);
      const existing = merged.get(row.id);
      if (existing) {
        existing.score += score;
        if (rank < existing.firstRank) {
          existing.firstRank = rank;
          existing.firstSet = setIndex;
          existing.row = {
            ...row,
            expansion_query: resultSet.query,
          };
        }
        return;
      }

      merged.set(row.id, {
        row: {
          ...row,
          expansion_query: resultSet.query,
        },
        score,
        firstRank: rank,
        firstSet: setIndex,
      });
    });
  });

  return [...merged.values()]
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      if (a.firstSet !== b.firstSet) {
        return a.firstSet - b.firstSet;
      }
      if (a.firstRank !== b.firstRank) {
        return a.firstRank - b.firstRank;
      }
      return a.row.id - b.row.id;
    })
    .slice(0, limit)
    .map((entry) => ({
      ...entry.row,
      rrf_score: entry.score,
    }));
}

async function retrieveMemoryCandidates(
  params: Required<SearchMemoryForToolParams>,
  limit: number,
  queryEmbedding?: number[] | null,
): Promise<MemorySearchChunkRow[]> {
  let expansionQueries = [params.query];
  if (shouldExpandMemoryQuery() && countSearchTerms(params.query) >= MEMORY_QUERY_EXPANSION_MIN_TERMS) {
    try {
      expansionQueries = await generateMemoryQueryExpansions(params.query);
    } catch (error) {
      console.error("memory_retrieval.query_expansion_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const aliasQueries = buildMemoryLexicalAliasQueries(params.query);
  const retrievalQueries: string[] = [];
  const seenQueries = new Set<string>();
  for (const query of [...expansionQueries, ...aliasQueries]) {
    pushUniqueQueryVariant(retrievalQueries, seenQueries, query);
  }

  if (retrievalQueries.length === 1) {
    return await retrieveParentAwareMemoryCandidatesForQuery(params, limit, queryEmbedding);
  }

  const resultSets = [];
  for (const query of retrievalQueries) {
    resultSets.push({
      query,
      rows: await retrieveParentAwareMemoryCandidatesForQuery(
        { ...params, query },
        limit,
        queryEmbedding,
      ),
    });
  }

  return prioritizeWorkspaceProactiveRows(
    mergeMemoryCandidateRowsByRrf(resultSets, limit),
    extractSignificantExactTerms(params.query),
  );
}

async function rerankMemoryRows(
  query: string,
  rows: MemorySearchChunkRow[],
  limit: number,
): Promise<MemorySearchChunkRow[]> {
  if (rows.length === 0) {
    return [];
  }

  const model = getMemoryRerankModel();
  const anthropic = new Anthropic();
  const response = await anthropic.messages.create({
    model,
    max_tokens: 2048,
    temperature: 0,
    system:
      "You are a strict retrieval relevance judge. Score each candidate for whether it helps answer the exact query. Return only JSON: {\"answerable\":boolean,\"scores\":[{\"id\":number,\"score\":0|1|2|3}]}. Set answerable=false when none of the candidates contain enough evidence to answer the exact query. Scores: 3 directly answers the specific query, 2 contains evidence for the specific requested fact or attribute, 1 is topical/entity overlap only, 0 irrelevant. If the candidate does not contain the requested fact, attribute, or answer, score 0 or 1. Do not include rationale.",
    messages: [
      {
        role: "user",
        content: JSON.stringify({
          query,
          candidates: rows.map((row) => ({
            id: row.id,
            source_type: row.source_type,
            title: row.title,
            author_name: row.author_name,
            published_at: row.published_at,
            entity_labels: row.entity_labels ?? [],
            text: row.text ?? row.snippet ?? "",
          })),
        }),
      },
    ],
  });

  const rerankPayload = parseMemoryRerankerPayload(
    extractAnthropicText(response),
    rows.map((row) => row.id),
  );
  if (rerankPayload.answerable === false) {
    return [];
  }
  const scores = rerankPayload.scores;
  const scoreById = new Map(scores.map((score) => [score.id, score.score]));
  const minRelevance = normalizeMemoryRerankMinRelevance();

  return rows
    .map((row, index) => ({
      row,
      index,
      score: scoreById.get(row.id) ?? 0,
    }))
    .filter((item) => item.score >= minRelevance)
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return a.index - b.index;
    })
    .slice(0, limit)
    .map((item) => ({
      ...item.row,
      rerank_score: item.score,
      rerank_model: model,
    }));
}

export async function searchMemoryForTool(
  params: SearchMemoryForToolParams,
): Promise<SearchMemoryToolResult> {
  const normalized = normalizeSearchParams(params);

  if (!normalized.query) {
    return withCurrentDigestSearchMetadata({
      query: normalized.query,
      scope: normalized.scope,
      source: normalized.source,
      ...(normalized.mode === "evidence"
        ? {
            mode: "evidence" as const,
            paper_evidence: {
              status: "unsupported" as const,
              candidate_feed_item_ids: [],
              supporting_chunk_ids: [],
              related_chunk_ids: [],
              reason: "no query was provided for paper evidence verification",
            },
          }
        : {}),
      results: [],
    }, normalized.feedItemIds);
  }

  if (isExplicitNoAnswerProbe(normalized.query)) {
    return withCurrentDigestSearchMetadata({
      query: normalized.query,
      scope: normalized.scope,
      source: normalized.source,
      ...(normalized.mode === "evidence"
        ? {
            mode: "evidence" as const,
            paper_evidence: {
              status: "unsupported" as const,
              candidate_feed_item_ids: [],
              supporting_chunk_ids: [],
              related_chunk_ids: [],
              reason: "query matched an explicit unsupported/no-answer probe",
            },
          }
        : {}),
      results: [],
    }, normalized.feedItemIds);
  }

  const rerankEnabled = isMemoryRerankEnabled();
  const candidateLimit = normalizeMemoryRetrievalCandidateLimit(
    normalized.limit,
  );
  let queryEmbeddingPromise: Promise<number[] | null> | null = null;
  const getQueryEmbedding = () => {
    if (!isMemoryVectorEnabled()) {
      return Promise.resolve(null);
    }
    queryEmbeddingPromise ??= embedMemoryText(normalized.query)
      .then(({ embedding }) => embedding)
      .catch((error) => {
        console.error("memory_retrieval.query_embedding_failed", {
          query: normalized.query,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      });
    return queryEmbeddingPromise;
  };

  if (normalized.mode === "evidence") {
    if (normalized.source !== "paper") {
      return withCurrentDigestSearchMetadata({
        query: normalized.query,
        scope: normalized.scope,
        source: normalized.source,
        mode: "evidence",
        paper_evidence: {
          status: "unsupported",
          candidate_feed_item_ids: [],
          supporting_chunk_ids: [],
          related_chunk_ids: [],
          reason: "paper evidence mode requires source='paper'",
        },
        results: [],
      }, normalized.feedItemIds);
    }

    const evidenceCandidateLimit = Math.min(
      normalized.limit,
      PAPER_EVIDENCE_CANDIDATE_LIMIT,
    );
    const graphPlan = buildPaperEvidenceFacetPlan(
      normalized.query,
      normalized.feedItemIds.length > 0 ? normalized.feedItemIds : undefined,
    );
    let candidateFeedItemIds = candidateIdsFromEvidenceGraphPlan(
      graphPlan,
      evidenceCandidateLimit,
    );
    if (candidateFeedItemIds.length === 0) {
      candidateFeedItemIds = await queryFastPaperEvidenceCandidateIds(
        normalized,
        evidenceCandidateLimit,
      );
    }

    let verification: ReturnType<typeof verifyPaperEvidenceChunks> | null = null;
    let evidenceHits: PaperEvidenceSearchAttempt["evidenceHits"] = [];

    if (candidateFeedItemIds.length > 0) {
      const paperEvidencePlan = buildPaperEvidenceFacetPlan(
        normalized.query,
        candidateFeedItemIds,
      );
      const attempt = await runPaperEvidenceSearchForCandidateIds({
        normalized,
        candidateFeedItemIds,
        plan: paperEvidencePlan,
        queryEmbedding: await getQueryEmbedding(),
      });
      verification = attempt.verification;
      evidenceHits = attempt.evidenceHits;
    }

    if (verification?.metadata.status !== "supports") {
      let rows = await retrieveMemoryCandidates(
        normalized,
        candidateLimit,
        await getQueryEmbedding(),
      );
      if (rerankEnabled) {
        try {
          rows = await rerankMemoryRows(normalized.query, rows, normalized.limit);
        } catch (error) {
          console.error("memory_retrieval.rerank_failed", {
            error: error instanceof Error ? error.message : String(error),
          });
          rows = [];
        }
      }
      rows = rerankPaperRowsByEvidenceGraph(normalized.query, rows);

      const fallbackCandidateFeedItemIds = [
        ...new Set(rows.map((row) => row.feed_item_id)),
      ].slice(0, evidenceCandidateLimit);
      const shouldRunFallback =
        fallbackCandidateFeedItemIds.length > 0 &&
        fallbackCandidateFeedItemIds.join(",") !== candidateFeedItemIds.join(",");

      if (shouldRunFallback) {
        candidateFeedItemIds = fallbackCandidateFeedItemIds;
        const paperEvidencePlan = buildPaperEvidenceFacetPlan(
          normalized.query,
          candidateFeedItemIds,
        );
        const attempt = await runPaperEvidenceSearchForCandidateIds({
          normalized,
          candidateFeedItemIds,
          plan: paperEvidencePlan,
          queryEmbedding: await getQueryEmbedding(),
        });
        verification = attempt.verification;
        evidenceHits = attempt.evidenceHits;
      }
    }

    if (!verification) {
      verification = verifyPaperEvidenceChunks({
        query: normalized.query,
        candidateFeedItemIds: [],
        hits: [],
      });
    }

    const supportingChunks = verification.chunks.filter((chunk) => chunk.supports);
    const supportingChunkIds = new Set(
      verification.metadata.supporting_chunk_ids,
    );
    const supportingHitKeys = new Set(
      supportingChunks.map((chunk) => paperEvidenceHitKey(chunk.hit)),
    );
    const supportingSpanIds = [
      ...new Set(
        supportingChunks
          .map((chunk) => chunk.hit.paper_evidence?.span_id)
          .filter((spanId): spanId is number => spanId != null),
      ),
    ];
    const supportingCardIds = [
      ...new Set(
        supportingChunks
          .map((chunk) => chunk.hit.paper_evidence?.card_id)
          .filter((cardId): cardId is number => cardId != null),
      ),
    ];
    const paperEvidenceDebug = normalized.debug
      ? verification.chunks.map(toPaperEvidenceDebugChunk)
      : undefined;
    const paperEvidenceMetadata = {
      ...verification.metadata,
      ...(supportingSpanIds.length > 0
        ? { supporting_span_ids: supportingSpanIds }
        : {}),
      ...(supportingCardIds.length > 0
        ? { supporting_card_ids: supportingCardIds }
        : {}),
    };

    return withCurrentDigestSearchMetadata({
      query: normalized.query,
      scope: normalized.scope,
      source: normalized.source,
      mode: "evidence",
      paper_evidence: paperEvidenceMetadata,
      ...(paperEvidenceDebug ? { paper_evidence_debug: paperEvidenceDebug } : {}),
      results: evidenceHits
        .filter(
          (hit) =>
            supportingHitKeys.has(paperEvidenceHitKey(hit)) ||
            (supportingHitKeys.size === 0 && supportingChunkIds.has(hit.id)),
        )
        .slice(0, normalized.limit)
        .map(toPublicSearchChunkHit),
    }, normalized.feedItemIds);
  }

  let rows = await retrieveMemoryCandidates(
    normalized,
    candidateLimit,
    await getQueryEmbedding(),
  );
  if (rerankEnabled) {
    try {
      rows = await rerankMemoryRows(normalized.query, rows, normalized.limit);
    } catch (error) {
      console.error("memory_retrieval.rerank_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      rows = [];
    }
  }
  rows = rerankPaperRowsByEvidenceGraph(normalized.query, rows);

  return withCurrentDigestSearchMetadata({
    query: normalized.query,
    scope: normalized.scope,
    source: normalized.source,
    results: rows
      .slice(0, normalized.limit)
      .map(mapSearchChunkRow)
      .filter((hit) => hit.snippet),
  }, normalized.feedItemIds);
}

export async function getMemoryItemForTool({
  memoryId,
}: GetMemoryItemForToolParams): Promise<GetMemoryChunkToolResult | null> {
  const rows = (await sql`
    SELECT
      kc.id,
      kc.feed_item_id,
      kc.source_type,
      kc.title,
      kc.author_name,
      kc.published_at,
      fi.url,
      kc.text,
      kc.entity_labels
    FROM knowledge_chunks kc
    JOIN feed_items fi ON fi.id = kc.feed_item_id
    WHERE kc.id = ${memoryId}
    LIMIT 1
  `) as MemoryChunkDetailRow[];
  const row = rows[0];

  if (!row) {
    return null;
  }

  return {
    kind: "chunk",
    id: row.id,
    feed_item_id: row.feed_item_id,
    source_type: row.source_type,
    title: row.title,
    author_name: row.author_name,
    published_at: row.published_at,
    url: row.url,
    text_excerpt: truncateAtBoundary(
      normalizePlainText(row.text),
      MAX_MEMORY_ITEM_EXCERPT_CHARS,
    ),
    entity_labels: row.entity_labels ?? [],
  };
}
