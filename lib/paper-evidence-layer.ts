import { createHash } from "node:crypto";

import { sql as defaultSql } from "@/lib/db";
import { embedMemoryTexts, formatPgVectorLiteral } from "@/lib/memory-embeddings";
import {
  refreshKnowledgeChunksForFeedItemIfStale,
  type MemoryBackfillFeedItem,
} from "@/lib/memory-chunks";
import {
  extractPaperEvidenceWithLlm,
  isPaperEvidenceLlmExtractorEnabled,
  validateLlmPaperEvidenceOutput,
} from "@/lib/paper-evidence-llm-extractor";
import {
  buildPaperReaderProfileDraft,
  type PaperReaderProfileDraft,
} from "@/lib/paper-reader-profile";
import type { PaperEvidenceHitMetadata } from "@/lib/schema";

export const PAPER_EVIDENCE_LAYER_PARSER_VERSION =
  "paper-evidence-layer-parser:v1";
export const PAPER_EVIDENCE_LAYER_EXTRACTOR_VERSION =
  "paper-evidence-layer-extractor:v2";

const MAX_EVIDENCE_SPANS_PER_PAPER = 1_200;
const MAX_EVIDENCE_CARDS_PER_PAPER = 160;
const MAX_SEARCH_QUERY_PARTS = 28;
const MAX_SEARCH_QUERY_CHARS = 1_500;
const SEARCH_RANK_CONSTANT = 60;
const PAPER_EVIDENCE_EMBEDDING_BATCH_SIZE = 96;

type SqlClient = typeof defaultSql;

export type PaperEvidenceLayerCorpusScope =
  | "all"
  | "default"
  | "latest"
  | "archive";

export type PaperSectionType =
  | "title"
  | "abstract"
  | "intro"
  | "method"
  | "result"
  | "discussion"
  | "limitation"
  | "appendix"
  | "references"
  | "unknown";

export type PaperEvidenceSpanType =
  | "paragraph"
  | "sentence"
  | "table_row"
  | "figure_caption"
  | "equation_context";

export type PaperEvidenceSpanOrigin = "llm_proposition" | "parser_sentence";

export type PaperEvidenceClaimType =
  | "contribution"
  | "method"
  | "dataset"
  | "benchmark"
  | "metric"
  | "result"
  | "limitation"
  | "comparison"
  | "implementation"
  | "unknown";

export interface PaperEvidenceSectionDraft {
  stableKey: string;
  feedItemId: number;
  sectionIndex: number;
  sectionPath: string[];
  sectionType: PaperSectionType;
  text: string;
  sourceHash: string;
  parserVersion: string;
}

export interface PaperEvidenceSpanDraft {
  stableKey: string;
  feedItemId: number;
  sectionIndex: number;
  spanIndex: number;
  spanType: PaperEvidenceSpanType;
  origin: PaperEvidenceSpanOrigin;
  text: string;
  normalizedText: string;
  backingChunkId: number | null;
  sourceHash: string;
  sourceStart?: number;
  sourceEnd?: number;
}

export interface PaperEvidenceCardDraft {
  stableKey: string;
  feedItemId: number;
  primarySupportSpanIndex: number;
  claim: string;
  claimType: PaperEvidenceClaimType;
  supportSpanIndexes: number[];
  sectionPath: string[];
  entities: string[];
  methods: string[];
  datasets: string[];
  metrics: string[];
  numbers: string[];
  aliases: string[];
  confidence: number;
  verifierStatus: "supports" | "paper_related_only" | "unsupported";
  extractorVersion: string;
  sourceHash: string;
}

export interface PaperEvidenceLayerDrafts {
  sourceHash: string;
  sections: PaperEvidenceSectionDraft[];
  spans: PaperEvidenceSpanDraft[];
  cards: PaperEvidenceCardDraft[];
  profile: PaperReaderProfileDraft;
  identityAnchors: string[];
  extractorMode: "deterministic" | "llm";
  droppedSpans: number;
  droppedClaims: number;
  droppedAnchors: number;
  emittedCandidateCount: number;
  llmInputTokens: number | null;
  llmOutputTokens: number | null;
}

export interface RebuildPaperEvidenceLayerOptions {
  dryRun?: boolean;
  refreshChunks?: boolean;
  extractorMode?: "configured" | "deterministic" | "llm";
  signal?: AbortSignal;
}

export interface PublishPreparedPaperEvidenceLayerOptions {
  embedSpans?: boolean;
}

export interface PreparedPaperEvidenceLayer {
  feedItemId: number;
  sourceHash: string | null;
  drafts: PaperEvidenceLayerDrafts | null;
  skipped: boolean;
  chunksRefreshed: boolean;
}

export interface RebuildPaperEvidenceLayerResult {
  feedItemId: number;
  sourceHash: string | null;
  sections: number;
  spans: number;
  cards: number;
  profiles: number;
  skipped: boolean;
  chunksRefreshed: boolean;
  droppedSpans?: number;
  droppedClaims?: number;
  droppedAnchors?: number;
  wouldEmbedCount?: number;
  embeddingInputCount?: number;
  embeddingFailedCount?: number;
  embeddingIncomplete?: boolean;
  llmInputTokens?: number | null;
  llmOutputTokens?: number | null;
}

export interface CurrentSourceSemanticEvidenceStatus {
  feedItemId: number;
  sourceHash: string;
  sectionCount: number;
  semanticSpanCount: number;
  cardCount: number;
  profileCount: number;
  missingEmbeddingCount: number;
  hasSemanticEvidence: boolean;
  embeddingsComplete: boolean;
}

export interface SemanticEmbeddingResumeResult
  extends CurrentSourceSemanticEvidenceStatus {
  embeddingInputCount: number;
  embeddingFailedCount: number;
  embeddingIncomplete: boolean;
}

export interface PaperEvidenceLayerSearchRow {
  id: number;
  feed_item_id: number;
  chunk_index: number | null;
  source_type: "paper";
  title: string | null;
  author_name: string;
  published_at: string | null;
  url: string;
  snippet: string;
  text: string;
  entity_labels: string[];
  fts_rank: number | null;
  vec_rank: number | null;
  vec_distance: number | null;
  rrf_score: number;
  expansion_query: string | null;
  origin: PaperEvidenceSpanOrigin;
  paper_evidence: PaperEvidenceHitMetadata;
  evidence_score: number;
}

export interface ParsedPaperEvidenceSection {
  sectionIndex: number;
  sectionPath: string[];
  sectionType: PaperSectionType;
  text: string;
}

interface KnowledgeChunkLookupRow {
  id: number;
  chunk_index: number | string | null;
  text: string;
}

interface StoredPaperEvidenceLayerRow {
  id: number | string;
  feed_item_id: number | string;
  chunk_index: number | string | null;
  title: string | null;
  author_name: string;
  published_at: string | null;
  url: string;
  span_id: number | string;
  card_id: number | string | null;
  section_path: string[] | null;
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
  sql_score: number | string | null;
  evidence_rank: number | string | null;
  fallback_chunk_id: number | string | null;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizePaperEvidenceLayerText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeFlat(value: string): string {
  return normalizePaperEvidenceLayerText(value).replace(/\s+/g, " ").trim();
}

function normalizeKeyText(value: string): string {
  return normalizeFlat(value).toLowerCase();
}

function toNumber(value: number | string | null | undefined): number | null {
  if (value == null) {
    return null;
  }
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toInteger(value: number | string | null | undefined): number | null {
  const parsed = toNumber(value);
  return parsed == null ? null : Math.trunc(parsed);
}

function unique(values: string[], limit = 24): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizeFlat(value);
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

function parseHeading(line: string): { level: number; title: string } | null {
  const markdown = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
  if (markdown) {
    return {
      level: markdown[1].length,
      title: normalizeFlat(markdown[2]),
    };
  }

  const html = line.match(/^\s*<h([1-6])[^>]*>(.*?)<\/h\1>\s*$/i);
  if (html) {
    return {
      level: Number.parseInt(html[1], 10),
      title: normalizeFlat(html[2].replace(/<[^>]+>/g, " ")),
    };
  }

  const trimmed = normalizeFlat(line);
  if (trimmed.length > 120 || /[.!?]\s*$/.test(trimmed)) {
    return null;
  }

  const numbered = trimmed.match(
    /^(\d+(?:\.\d+)*)\s+([A-Z][A-Za-z0-9 ,:/()&+\-]{2,110})$/,
  );
  if (numbered) {
    return {
      level: numbered[1].split(".").length + 1,
      title: normalizeFlat(numbered[2]),
    };
  }

  if (
    /^(abstract|introduction|related work|method|methods|approach|experiments|evaluation|results|discussion|limitations|conclusion|appendix|references)$/i.test(
      trimmed,
    )
  ) {
    return { level: 1, title: trimmed };
  }

  return null;
}

function classifySectionType(path: string[]): PaperSectionType {
  const title = normalizeKeyText(path[path.length - 1] ?? "");
  const fullPath = normalizeKeyText(path.join(" "));

  if (!title) {
    return "unknown";
  }
  if (/\btitle\b/.test(title)) {
    return "title";
  }
  if (/\babstract\b/.test(title)) {
    return "abstract";
  }
  if (/\bintro(?:duction)?\b/.test(title)) {
    return "intro";
  }
  if (/\b(method|methods|approach|model|architecture|system|framework|training|implementation)\b/.test(fullPath)) {
    return "method";
  }
  if (/\b(result|results|experiment|experiments|evaluation|benchmark|analysis|ablation|study)\b/.test(fullPath)) {
    return "result";
  }
  if (/\b(discussion|conclusion|future work)\b/.test(fullPath)) {
    return "discussion";
  }
  if (/\b(limit|limitation|limitations|failure|risk|threat)\b/.test(fullPath)) {
    return "limitation";
  }
  if (/\bappendix|supplementary\b/.test(fullPath)) {
    return "appendix";
  }
  if (/\breferences|bibliography\b/.test(fullPath)) {
    return "references";
  }
  return "unknown";
}

export function parsePaperEvidenceSections(
  item: Pick<MemoryBackfillFeedItem, "id" | "title" | "content" | "full_text">,
): ParsedPaperEvidenceSection[] {
  const sections: ParsedPaperEvidenceSection[] = [];
  const abstractText = normalizePaperEvidenceLayerText(item.content ?? "");
  if (abstractText) {
    sections.push({
      sectionIndex: 0,
      sectionPath: item.title?.trim()
        ? [item.title.trim(), "Abstract"]
        : ["Abstract"],
      sectionType: "abstract",
      text: abstractText,
    });
  }

  const fullText = item.full_text?.trim();
  if (!fullText) {
    return sections;
  }

  const normalizedLines = fullText
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd());
  const headingStack: Array<{ level: number; title: string }> = [];
  let currentPath: string[] =
    item.title && item.title.trim() ? [item.title.trim()] : ["Full text"];
  let currentLines: string[] = [];

  const flush = () => {
    const text = normalizePaperEvidenceLayerText(currentLines.join("\n"));
    if (text) {
      sections.push({
        sectionIndex: sections.length,
        sectionPath: currentPath,
        sectionType: classifySectionType(currentPath),
        text,
      });
    }
    currentLines = [];
  };

  for (const line of normalizedLines) {
    const heading = parseHeading(line);
    if (!heading?.title) {
      currentLines.push(line);
      continue;
    }

    flush();

    while (
      headingStack.length > 0 &&
      headingStack[headingStack.length - 1].level >= heading.level
    ) {
      headingStack.pop();
    }
    headingStack.push(heading);
    currentPath = headingStack.map((entry) => entry.title);
  }

  flush();

  return sections;
}

function splitSentences(text: string): string[] {
  const cleaned = normalizePaperEvidenceLayerText(text)
    .replace(/\be\.g\./gi, "eg")
    .replace(/\bi\.e\./gi, "ie");
  const sentences =
    cleaned.match(/[^.!?\n]+[.!?]+(?=\s|$)|[^.!?\n]+(?:\n|$)/g) ?? [];
  return sentences.map(normalizeFlat).filter((sentence) => sentence.length >= 35);
}

function inferSpanType(text: string, sectionType: PaperSectionType): PaperEvidenceSpanType {
  const lower = normalizeKeyText(text);
  if (/\b(table|row|column|dataset|benchmark)\b/.test(lower) && /[|;]/.test(text)) {
    return "table_row";
  }
  if (/\b(figure|fig\.|caption)\b/.test(lower)) {
    return "figure_caption";
  }
  if (/\b(equation|loss|objective|reward)\b/.test(lower) && /[=<>]/.test(text)) {
    return "equation_context";
  }
  if (sectionType === "result" || sectionType === "method") {
    return "sentence";
  }
  return "paragraph";
}

function stableKey(parts: Array<string | number>): string {
  return parts.join(":");
}

export function computePaperEvidenceLayerSourceHash(
  item: Pick<MemoryBackfillFeedItem, "id" | "title" | "content" | "full_text">,
): string {
  return hashText(
    [
      "paper-evidence-layer:v1",
      PAPER_EVIDENCE_LAYER_PARSER_VERSION,
      PAPER_EVIDENCE_LAYER_EXTRACTOR_VERSION,
      item.id,
      item.title ?? "",
      item.content ?? "",
      item.full_text ?? "",
    ].join("\n"),
  );
}

async function assertPaperEvidenceSpanEmbeddingSchema(sqlClient: SqlClient) {
  const rows = (await sqlClient`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'paper_evidence_spans'
      AND column_name = ANY(${[
        "embedding",
        "embedding_model",
        "embedding_updated_at",
      ]}::text[])
  `) as Array<{ column_name: string | null }>;

  const columns = new Set(rows.map((row) => row.column_name).filter(Boolean));
  const missing = ["embedding", "embedding_model", "embedding_updated_at"].filter(
    (column) => !columns.has(column),
  );
  if (missing.length > 0) {
    throw new Error(
      `paper_evidence_spans embedding columns are required before LLM extraction: missing ${missing.join(", ")}`,
    );
  }
}

function matchBackingChunkId(
  spanText: string,
  chunks: KnowledgeChunkLookupRow[],
): number | null {
  if (chunks.length === 0) {
    return null;
  }

  const spanKey = normalizeKeyText(spanText);
  if (!spanKey) {
    return null;
  }
  const compactNeedle = spanKey.slice(0, Math.min(220, spanKey.length));

  for (const chunk of chunks) {
    const chunkKey = normalizeKeyText(chunk.text);
    if (chunkKey.includes(spanKey) || chunkKey.includes(compactNeedle)) {
      return chunk.id;
    }
  }

  const terms = unique(
    spanKey
      .split(/[^a-z0-9]+/)
      .filter((term) => term.length >= 5 && !EVIDENCE_STOPWORDS.has(term)),
    16,
  );
  if (terms.length < 4) {
    return chunks[0]?.id ?? null;
  }

  let best: { id: number; score: number } | null = null;
  for (const chunk of chunks) {
    const chunkKey = normalizeKeyText(chunk.text);
    const score = terms.filter((term) => chunkKey.includes(term)).length;
    if (!best || score > best.score) {
      best = { id: chunk.id, score };
    }
  }

  return best && best.score >= Math.min(4, terms.length) ? best.id : chunks[0]?.id ?? null;
}

function buildSpanCandidates(section: ParsedPaperEvidenceSection): string[] {
  const sentences = splitSentences(section.text);
  const lines = section.text
    .split("\n")
    .map(normalizeFlat)
    .filter((line) => line.length >= 35 && line.length <= 1_300);
  const candidates: string[] = [];

  if (section.text.length <= 1_100) {
    candidates.push(section.text);
  }

  for (let index = 0; index < lines.length; index += 1) {
    candidates.push(lines[index]);
    const window = normalizeFlat(lines.slice(index, index + 2).join(" "));
    if (window.length >= 35 && window.length <= 1_300) {
      candidates.push(window);
    }
  }

  for (let index = 0; index < sentences.length; index += 1) {
    candidates.push(sentences[index]);
    const pair = sentences.slice(index, index + 2);
    if (pair.length === 2) {
      const window = normalizeFlat(pair.join(" "));
      if (window.length <= 1_100) {
        candidates.push(window);
      }
    }
  }

  return unique(
    candidates.filter((candidate) => {
      const text = normalizeFlat(candidate);
      return text.length >= 35 && text.length <= 1_300;
    }),
    500,
  );
}

export function extractPaperEvidenceSpans({
  feedItemId,
  sourceHash,
  sections,
  chunks,
}: {
  feedItemId: number;
  sourceHash: string;
  sections: ParsedPaperEvidenceSection[];
  chunks: KnowledgeChunkLookupRow[];
}): PaperEvidenceSpanDraft[] {
  const spans: PaperEvidenceSpanDraft[] = [];

  for (const section of sections) {
    if (section.sectionType === "references") {
      continue;
    }

    for (const text of buildSpanCandidates(section)) {
      const normalizedText = normalizeFlat(text);
      if (!normalizedText) {
        continue;
      }

      const spanIndex = spans.length;
      spans.push({
        stableKey: stableKey([
          "paper-span",
          feedItemId,
          sourceHash.slice(0, 16),
          spanIndex,
          hashText(normalizedText).slice(0, 16),
        ]),
        feedItemId,
        sectionIndex: section.sectionIndex,
        spanIndex,
        spanType: inferSpanType(normalizedText, section.sectionType),
        origin: "parser_sentence",
        text: normalizedText,
        normalizedText,
        backingChunkId: matchBackingChunkId(normalizedText, chunks),
        sourceHash,
      });

      if (spans.length >= MAX_EVIDENCE_SPANS_PER_PAPER) {
        return spans;
      }
    }
  }

  return spans;
}

const EVIDENCE_STOPWORDS = new Set([
  "about",
  "after",
  "also",
  "because",
  "before",
  "between",
  "could",
  "does",
  "from",
  "have",
  "into",
  "more",
  "paper",
  "should",
  "than",
  "that",
  "their",
  "these",
  "this",
  "those",
  "using",
  "where",
  "which",
  "while",
  "with",
  "would",
]);

function extractNumbers(text: string): string[] {
  return unique(
    text.match(
      /\b\d[\d,.]*(?:\s?(?:%|x|k|m|b|million|billion))?(?:\s+(?:agent|tool|calls?|logged|events?|coding|sessions?|user|prompts?|hours?|frames?|tasks?|questions?|cases?|examples?|environments?|tools?|accuracy|recall|precision|score|latency|cost)){0,4}\b/gi,
    ) ?? [],
    16,
  );
}

function extractCapitalizedPhrases(text: string): string[] {
  return unique(text.match(/\b[A-Z][A-Za-z0-9+-]*(?:[- ][A-Z0-9][A-Za-z0-9+-]*){0,4}\b/g) ?? [], 16);
}

function extractTermsByPattern(text: string, pattern: RegExp): string[] {
  return unique(text.match(pattern) ?? [], 16);
}

function classifyClaimType(text: string, sectionType: PaperSectionType): PaperEvidenceClaimType {
  const lower = normalizeKeyText(text);
  if (/\b(limit|limitation|fail|failure|risk|cannot|can't|only|however|but)\b/.test(lower)) {
    return "limitation";
  }
  if (/\b(dataset|corpus|sessions?|prompts?|tool calls?|events?|examples?|demonstrations?)\b/.test(lower)) {
    return "dataset";
  }
  if (/\b(benchmark|evaluation|evaluates?|suite|tasks?|questions?|cases?|score|leaderboard)\b/.test(lower)) {
    return "benchmark";
  }
  if (/\b(accuracy|recall|precision|f1|pass rate|success rate|score|latency|cost|percent|%)\b/.test(lower)) {
    return "metric";
  }
  if (/\b(result|results|outperform|improves?|achieves?|reaches?|reports?)\b/.test(lower) || sectionType === "result") {
    return "result";
  }
  if (/\b(method|framework|architecture|compiler|planner|retrieval|training|algorithm|policy|pipeline|workflow)\b/.test(lower) || sectionType === "method") {
    return "method";
  }
  if (/\b(implement|implementation|open-source|repository|api|tool)\b/.test(lower)) {
    return "implementation";
  }
  if (/\b(compare|comparison|versus|vs\.|baseline|baselines)\b/.test(lower)) {
    return "comparison";
  }
  if (/\b(we introduce|we propose|we present|contribution|contributions)\b/.test(lower)) {
    return "contribution";
  }
  return "unknown";
}

function scoreCardCandidate(
  text: string,
  claimType: PaperEvidenceClaimType,
  sectionType: PaperSectionType,
): number {
  const lower = normalizeKeyText(text);
  let score = 0;
  score += Math.min(extractNumbers(text).length, 4) * 2.2;
  if (claimType !== "unknown") {
    score += 3;
  }
  if (sectionType === "method" || sectionType === "result" || sectionType === "limitation") {
    score += 1.5;
  }
  if (/\b(we introduce|we propose|we present|we evaluate|we find|we show|our results|this paper)\b/.test(lower)) {
    score += 2;
  }
  if (/\b(dataset|benchmark|evaluation|method|framework|architecture|accuracy|score|latency|success rate|pass rate|tool calls?|sessions?)\b/.test(lower)) {
    score += 2;
  }
  if (text.length >= 120 && text.length <= 700) {
    score += 1;
  }
  return score;
}

function sectionPriority(sectionType: PaperSectionType): number {
  switch (sectionType) {
    case "result":
      return 6;
    case "method":
      return 5;
    case "limitation":
      return 4;
    case "abstract":
      return 3;
    case "intro":
    case "discussion":
      return 2;
    case "appendix":
      return 1;
    case "references":
      return -6;
    case "title":
    case "unknown":
      return 0;
  }
}

export function extractPaperEvidenceCards({
  feedItemId,
  sourceHash,
  sections,
  spans,
}: {
  feedItemId: number;
  sourceHash: string;
  sections: ParsedPaperEvidenceSection[];
  spans: PaperEvidenceSpanDraft[];
}): PaperEvidenceCardDraft[] {
  const sectionByIndex = new Map(sections.map((section) => [section.sectionIndex, section]));
  const scored = spans
    .map((span) => {
      const section = sectionByIndex.get(span.sectionIndex);
      const claimType = classifyClaimType(span.text, section?.sectionType ?? "unknown");
      return {
        span,
        section,
        claimType,
        score:
          scoreCardCandidate(span.text, claimType, section?.sectionType ?? "unknown") +
          sectionPriority(section?.sectionType ?? "unknown") * 0.25,
      };
    })
    .filter(({ score }) => score >= 4)
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return a.span.spanIndex - b.span.spanIndex;
    })
    .slice(0, MAX_EVIDENCE_CARDS_PER_PAPER);

  return scored.map(({ span, section, claimType, score }, index) => {
    const numbers = extractNumbers(span.text);
    const aliases = extractCapitalizedPhrases(span.text);
    const methods = extractTermsByPattern(
      span.text,
      /\b(?:framework|architecture|compiler|planner|retrieval|training|algorithm|policy|pipeline|workflow|agent|agents|tool-use|tools?)\b/gi,
    );
    const datasets = extractTermsByPattern(
      span.text,
      /\b(?:dataset|corpus|benchmark|suite|sessions?|prompts?|tool calls?|events?|tasks?|questions?|cases?|demonstrations?)\b/gi,
    );
    const metrics = extractTermsByPattern(
      span.text,
      /\b(?:accuracy|recall|precision|f1|pass rate|success rate|score|latency|cost|percent|percentage|%)\b/gi,
    );
    const entities = unique([...aliases, ...methods, ...datasets], 24);

    return {
      stableKey: stableKey([
        "paper-card",
        feedItemId,
        sourceHash.slice(0, 16),
        index,
        span.spanIndex,
      ]),
      feedItemId,
      primarySupportSpanIndex: span.spanIndex,
      claim: span.text,
      claimType,
      supportSpanIndexes: [span.spanIndex],
      sectionPath: section?.sectionPath ?? [],
      entities,
      methods,
      datasets,
      metrics,
      numbers,
      aliases,
      confidence: Math.min(0.95, 0.45 + score / 18),
      verifierStatus: "supports",
      extractorVersion: PAPER_EVIDENCE_LAYER_EXTRACTOR_VERSION,
      sourceHash,
    };
  });
}

function buildDeterministicPaperEvidenceLayerDrafts({
  item,
  sourceHash,
  sections,
  parsedSections,
  chunks,
}: {
  item: MemoryBackfillFeedItem;
  sourceHash: string;
  sections: PaperEvidenceSectionDraft[];
  parsedSections: ParsedPaperEvidenceSection[];
  chunks: KnowledgeChunkLookupRow[];
}): PaperEvidenceLayerDrafts {
  const spans = extractPaperEvidenceSpans({
    feedItemId: item.id,
    sourceHash,
    sections: parsedSections,
    chunks,
  });
  const cards = extractPaperEvidenceCards({
    feedItemId: item.id,
    sourceHash,
    sections: parsedSections,
    spans,
  });
  const profile = buildPaperReaderProfileDraft({
    item,
    sourceHash,
    sections,
    cards,
    parserVersion: PAPER_EVIDENCE_LAYER_PARSER_VERSION,
    extractorVersion: PAPER_EVIDENCE_LAYER_EXTRACTOR_VERSION,
  });

  return {
    sourceHash,
    sections,
    spans,
    cards,
    profile,
    identityAnchors: [],
    extractorMode: "deterministic",
    droppedSpans: 0,
    droppedClaims: 0,
    droppedAnchors: 0,
    emittedCandidateCount: spans.length,
    llmInputTokens: null,
    llmOutputTokens: null,
  };
}

function buildLlmPaperEvidenceCardDrafts({
  feedItemId,
  sourceHash,
  sections,
  spans,
  claims,
}: {
  feedItemId: number;
  sourceHash: string;
  sections: ParsedPaperEvidenceSection[];
  spans: PaperEvidenceSpanDraft[];
  claims: ReturnType<typeof validateLlmPaperEvidenceOutput>["acceptedClaims"];
}): PaperEvidenceCardDraft[] {
  const sectionByIndex = new Map(sections.map((section) => [section.sectionIndex, section]));
  const dedupedCards = new Map<string, PaperEvidenceCardDraft>();
  for (const claim of claims) {
    const primarySpan = spans[claim.primarySupportSpanIndex];
    if (!primarySpan) {
      continue;
    }
    const primarySection = sectionByIndex.get(primarySpan.sectionIndex);
    const claimText = normalizeFlat(claim.claim);
    const card: PaperEvidenceCardDraft = {
      stableKey: stableKey([
        "paper-llm-card",
        feedItemId,
        sourceHash.slice(0, 16),
        claim.primarySupportSpanIndex,
        hashText(claimText).slice(0, 16),
      ]),
      feedItemId,
      primarySupportSpanIndex: claim.primarySupportSpanIndex,
      claim: claimText,
      claimType: claim.claimType,
      supportSpanIndexes: claim.supportSpanIndexes,
      sectionPath: primarySection?.sectionPath ?? [],
      entities: claim.entities,
      methods: claim.methods,
      datasets: claim.datasets,
      metrics: claim.metrics,
      numbers: claim.numbers,
      aliases: claim.aliases,
      confidence: claim.confidence,
      verifierStatus: "supports",
      extractorVersion: PAPER_EVIDENCE_LAYER_EXTRACTOR_VERSION,
      sourceHash,
    };
    const dedupeKey = `${card.primarySupportSpanIndex}:${card.claimType}`;
    const existing = dedupedCards.get(dedupeKey);
    if (
      !existing ||
      card.confidence > existing.confidence ||
      (card.confidence === existing.confidence && card.claim.length > existing.claim.length)
    ) {
      dedupedCards.set(dedupeKey, card);
    }
  }
  return [...dedupedCards.values()];
}

function appendParserBackedSourceSpans({
  feedItemId,
  sourceHash,
  llmSpans,
  parserSpans,
}: {
  feedItemId: number;
  sourceHash: string;
  llmSpans: PaperEvidenceSpanDraft[];
  parserSpans: PaperEvidenceSpanDraft[];
}): PaperEvidenceSpanDraft[] {
  const merged = [...llmSpans];
  const seen = new Set(
    llmSpans.map((span) => normalizeKeyText(span.normalizedText)),
  );

  for (const span of parserSpans) {
    const normalizedKey = normalizeKeyText(span.normalizedText);
    if (!normalizedKey || seen.has(normalizedKey)) {
      continue;
    }
    seen.add(normalizedKey);
    const spanIndex = merged.length;
    merged.push({
      ...span,
      spanIndex,
      origin: "parser_sentence",
      stableKey: stableKey([
        "paper-llm-parser-span",
        feedItemId,
        sourceHash.slice(0, 16),
        spanIndex,
        hashText(span.normalizedText).slice(0, 16),
      ]),
    });
    if (merged.length >= MAX_EVIDENCE_SPANS_PER_PAPER) {
      break;
    }
  }

  return merged;
}

function remapParserSpansToMergedIndexes({
  parserSpans,
  mergedSpans,
}: {
  parserSpans: PaperEvidenceSpanDraft[];
  mergedSpans: PaperEvidenceSpanDraft[];
}): PaperEvidenceSpanDraft[] {
  const mergedIndexByNormalizedText = new Map<string, number>();
  for (const span of mergedSpans) {
    const normalized = normalizeKeyText(span.normalizedText);
    if (normalized && !mergedIndexByNormalizedText.has(normalized)) {
      mergedIndexByNormalizedText.set(normalized, span.spanIndex);
    }
  }

  return parserSpans
    .map((span) => {
      const mergedSpanIndex = mergedIndexByNormalizedText.get(
        normalizeKeyText(span.normalizedText),
      );
      if (mergedSpanIndex == null) {
        return null;
      }
      return {
        ...span,
        spanIndex: mergedSpanIndex,
      };
    })
    .filter((span): span is PaperEvidenceSpanDraft => span != null);
}

function mergeLlmAndParserFallbackCards({
  llmCards,
  parserFallbackCards,
}: {
  llmCards: PaperEvidenceCardDraft[];
  parserFallbackCards: PaperEvidenceCardDraft[];
}): PaperEvidenceCardDraft[] {
  const merged = new Map<string, PaperEvidenceCardDraft>();
  for (const card of parserFallbackCards) {
    const key = `${card.primarySupportSpanIndex}:${card.claimType}`;
    if (!merged.has(key)) {
      merged.set(key, card);
    }
  }

  for (const card of llmCards) {
    const key = `${card.primarySupportSpanIndex}:${card.claimType}`;
    if (merged.has(key)) {
      merged.set(key, card);
      continue;
    }
    if (merged.size < MAX_EVIDENCE_CARDS_PER_PAPER) {
      merged.set(key, card);
    }
  }

  return [...merged.values()];
}

async function buildLlmPaperEvidenceLayerDrafts({
  item,
  sourceHash,
  sections,
  parsedSections,
  chunks,
  signal,
}: {
  item: MemoryBackfillFeedItem;
  sourceHash: string;
  sections: PaperEvidenceSectionDraft[];
  parsedSections: ParsedPaperEvidenceSection[];
  chunks: KnowledgeChunkLookupRow[];
  signal?: AbortSignal;
}): Promise<PaperEvidenceLayerDrafts> {
  const fullText = item.full_text ?? item.content ?? "";
  const llmResult = await extractPaperEvidenceWithLlm({
    feedItemId: item.id,
    title: item.title,
    externalId: (item as { external_id?: string | null }).external_id ?? null,
    fullText,
    sections: parsedSections,
    signal,
  });
  signal?.throwIfAborted();
  const validated = validateLlmPaperEvidenceOutput({
    feedItemId: item.id,
    fullText,
    sections: parsedSections,
    extraction: llmResult.extraction,
  });

  const spans = validated.acceptedSpans.map((span, index): PaperEvidenceSpanDraft => ({
    stableKey: stableKey([
      "paper-llm-span",
      item.id,
      sourceHash.slice(0, 16),
      span.spanType,
      span.sourceStart,
      span.sourceEnd,
      hashText(span.normalizedText).slice(0, 16),
    ]),
    feedItemId: item.id,
    sectionIndex: span.sectionIndex,
    spanIndex: index,
    spanType: span.spanType,
    origin: "llm_proposition",
    text: span.text,
    normalizedText: span.normalizedText,
    backingChunkId: matchBackingChunkId(span.text, chunks),
    sourceHash,
    sourceStart: span.sourceStart,
    sourceEnd: span.sourceEnd,
  }));
  const parserSpans = extractPaperEvidenceSpans({
    feedItemId: item.id,
    sourceHash,
    sections: parsedSections,
    chunks,
  });
  const mergedSpans = appendParserBackedSourceSpans({
    feedItemId: item.id,
    sourceHash,
    llmSpans: spans,
    parserSpans,
  });
  const llmCards = buildLlmPaperEvidenceCardDrafts({
    feedItemId: item.id,
    sourceHash,
    sections: parsedSections,
    spans: mergedSpans,
    claims: validated.acceptedClaims,
  });
  const parserFallbackCards = extractPaperEvidenceCards({
    feedItemId: item.id,
    sourceHash,
    sections: parsedSections,
    spans: remapParserSpansToMergedIndexes({
      parserSpans,
      mergedSpans,
    }),
  });
  const cards = mergeLlmAndParserFallbackCards({
    llmCards,
    parserFallbackCards,
  });
  const deterministicProfile = buildPaperReaderProfileDraft({
    item,
    sourceHash,
    sections,
    cards,
    parserVersion: PAPER_EVIDENCE_LAYER_PARSER_VERSION,
    extractorVersion: PAPER_EVIDENCE_LAYER_EXTRACTOR_VERSION,
  });

  return {
    sourceHash,
    sections,
    spans: mergedSpans,
    cards,
    profile: {
      ...deterministicProfile,
      identityAnchors: unique(
        [
          ...validated.acceptedCoinedTermAnchors,
          ...deterministicProfile.identityAnchors,
        ],
        24,
      ),
    },
    identityAnchors: validated.acceptedCoinedTermAnchors,
    extractorMode: "llm",
    droppedSpans: validated.droppedSpanCount,
    droppedClaims: validated.droppedClaimCount,
    droppedAnchors: validated.droppedAnchorCount,
    emittedCandidateCount: validated.emittedCandidateCount,
    llmInputTokens: llmResult.inputTokens,
    llmOutputTokens: llmResult.outputTokens,
  };
}

export async function buildPaperEvidenceLayerDrafts(
  sqlClient: SqlClient,
  item: MemoryBackfillFeedItem,
  options: Pick<RebuildPaperEvidenceLayerOptions, "extractorMode" | "signal"> = {},
): Promise<PaperEvidenceLayerDrafts> {
  options.signal?.throwIfAborted();
  const sourceHash = computePaperEvidenceLayerSourceHash(item);
  const sections = parsePaperEvidenceSections(item).map((section) => ({
    stableKey: stableKey([
      "paper-section",
      item.id,
      sourceHash.slice(0, 16),
      section.sectionIndex,
    ]),
    feedItemId: item.id,
    sectionIndex: section.sectionIndex,
    sectionPath: section.sectionPath,
    sectionType: section.sectionType,
    text: section.text,
    sourceHash,
    parserVersion: PAPER_EVIDENCE_LAYER_PARSER_VERSION,
  }));

  const chunks = (await sqlClient`
    SELECT id, chunk_index, text
    FROM knowledge_chunks
    WHERE feed_item_id = ${item.id}
    ORDER BY chunk_index ASC, id ASC
  `) as KnowledgeChunkLookupRow[];

  const parsedSections: ParsedPaperEvidenceSection[] = sections.map((section) => ({
    sectionIndex: section.sectionIndex,
    sectionPath: section.sectionPath,
    sectionType: section.sectionType,
    text: section.text,
  }));

  const useLlmExtractor =
    options.extractorMode === "llm" ||
    (
      options.extractorMode === "configured" &&
      isPaperEvidenceLlmExtractorEnabled()
    );

  if (useLlmExtractor) {
    await assertPaperEvidenceSpanEmbeddingSchema(sqlClient);
    options.signal?.throwIfAborted();
    return buildLlmPaperEvidenceLayerDrafts({
      item,
      sourceHash,
      sections,
      parsedSections,
      chunks,
      signal: options.signal,
    });
  }

  return buildDeterministicPaperEvidenceLayerDrafts({
    item,
    sourceHash,
    sections,
    parsedSections,
    chunks,
  });
}

async function embedInsertedPaperEvidenceSpans(
  sqlClient: SqlClient,
  spans: Array<{ id: number; text: string }>,
): Promise<{ embeddingInputCount: number; embeddingFailedCount: number }> {
  let embeddingInputCount = 0;
  let embeddingFailedCount = 0;

  for (let index = 0; index < spans.length; index += PAPER_EVIDENCE_EMBEDDING_BATCH_SIZE) {
    const batch = spans.slice(index, index + PAPER_EVIDENCE_EMBEDDING_BATCH_SIZE);
    embeddingInputCount += batch.length;
    try {
      const { embeddings, model } = await embedMemoryTexts(batch.map((span) => span.text));
      for (let batchIndex = 0; batchIndex < batch.length; batchIndex += 1) {
        const embedding = embeddings[batchIndex];
        const span = batch[batchIndex];
        if (!embedding) {
          embeddingFailedCount += 1;
          continue;
        }
        const vectorLiteral = formatPgVectorLiteral(embedding);
        await sqlClient`
          UPDATE paper_evidence_spans
          SET
            embedding = ${vectorLiteral}::vector,
            embedding_model = ${model},
            embedding_updated_at = NOW(),
            updated_at = NOW()
          WHERE id = ${span.id}
        `;
      }
      if (embeddings.length < batch.length) {
        embeddingFailedCount += batch.length - embeddings.length;
      }
    } catch (error) {
      embeddingFailedCount += batch.length;
      console.error("paper_evidence_layer.embedding_failed", {
        count: batch.length,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { embeddingInputCount, embeddingFailedCount };
}

export async function getCurrentSourceSemanticEvidenceStatus(
  sqlClient: SqlClient,
  item: Pick<MemoryBackfillFeedItem, "id" | "title" | "content" | "full_text">,
): Promise<CurrentSourceSemanticEvidenceStatus> {
  const sourceHash = computePaperEvidenceLayerSourceHash(item);
  const rows = (await sqlClient`
    SELECT
      (
        SELECT COUNT(*)
        FROM paper_sections
        WHERE feed_item_id = ${item.id}
          AND source_hash = ${sourceHash}
      ) AS section_count,
      (
        SELECT COUNT(*)
        FROM paper_evidence_spans
        WHERE feed_item_id = ${item.id}
          AND source_hash = ${sourceHash}
          AND origin = 'llm_proposition'
      ) AS semantic_span_count,
      (
        SELECT COUNT(*)
        FROM paper_evidence_cards
        WHERE feed_item_id = ${item.id}
          AND source_hash = ${sourceHash}
      ) AS card_count,
      (
        SELECT COUNT(*)
        FROM paper_reader_profiles
        WHERE feed_item_id = ${item.id}
          AND source_hash = ${sourceHash}
      ) AS profile_count,
      (
        SELECT COUNT(*)
        FROM paper_evidence_spans
        WHERE feed_item_id = ${item.id}
          AND source_hash = ${sourceHash}
          AND origin = 'llm_proposition'
          AND embedding IS NULL
      ) AS missing_embedding_count
  `) as Array<{
    section_count: number | string | null;
    semantic_span_count: number | string | null;
    card_count: number | string | null;
    profile_count: number | string | null;
    missing_embedding_count: number | string | null;
  }>;
  const sectionCount = toInteger(rows[0]?.section_count) ?? 0;
  const semanticSpanCount = toInteger(rows[0]?.semantic_span_count) ?? 0;
  const cardCount = toInteger(rows[0]?.card_count) ?? 0;
  const profileCount = toInteger(rows[0]?.profile_count) ?? 0;
  const missingEmbeddingCount = toInteger(rows[0]?.missing_embedding_count) ?? 0;
  const hasSemanticEvidence =
    sectionCount > 0 &&
    semanticSpanCount > 0 &&
    cardCount > 0 &&
    profileCount > 0;
  return {
    feedItemId: item.id,
    sourceHash,
    sectionCount,
    semanticSpanCount,
    cardCount,
    profileCount,
    missingEmbeddingCount,
    hasSemanticEvidence,
    embeddingsComplete: hasSemanticEvidence && missingEmbeddingCount === 0,
  };
}

export async function embedMissingCurrentSourceSemanticSpans(
  sqlClient: SqlClient,
  item: Pick<MemoryBackfillFeedItem, "id" | "title" | "content" | "full_text">,
  { limit = PAPER_EVIDENCE_EMBEDDING_BATCH_SIZE }: { limit?: number } = {},
): Promise<SemanticEmbeddingResumeResult> {
  const sourceHash = computePaperEvidenceLayerSourceHash(item);
  const requestedLimit = Number.isFinite(limit) ? Math.trunc(limit) : 1;
  const batchLimit = Math.max(
    1,
    Math.min(requestedLimit, PAPER_EVIDENCE_EMBEDDING_BATCH_SIZE),
  );
  const rows = (await sqlClient`
    SELECT id, text
    FROM paper_evidence_spans
    WHERE feed_item_id = ${item.id}
      AND source_hash = ${sourceHash}
      AND origin = 'llm_proposition'
      AND embedding IS NULL
    ORDER BY span_index ASC, id ASC
    LIMIT ${batchLimit}
  `) as Array<{ id: number | string; text: string }>;
  const spans = rows
    .map((span) => {
      const id = toInteger(span.id);
      return id == null ? null : { id, text: span.text };
    })
    .filter((entry): entry is { id: number; text: string } => entry != null);
  const embeddingResult = await embedInsertedPaperEvidenceSpans(sqlClient, spans);
  const status = await getCurrentSourceSemanticEvidenceStatus(sqlClient, item);
  return {
    ...status,
    embeddingInputCount: embeddingResult.embeddingInputCount,
    embeddingFailedCount: embeddingResult.embeddingFailedCount,
    embeddingIncomplete: status.missingEmbeddingCount > 0,
  };
}

function validatePaperEvidenceLayerDrafts(drafts: PaperEvidenceLayerDrafts) {
  if (drafts.sections.length <= 0) {
    throw new Error("paper evidence draft has no sections");
  }
  if (drafts.spans.length <= 0) {
    throw new Error("paper evidence draft has no spans");
  }
  if (drafts.cards.length <= 0) {
    throw new Error("paper evidence draft has no cards");
  }
  if (!drafts.profile.profileText.trim()) {
    throw new Error("paper reader profile draft is empty");
  }
}

function jsonArray(values: unknown[]): string {
  return JSON.stringify(values);
}

async function publishPaperEvidenceLayerDrafts(
  sqlClient: SqlClient,
  drafts: PaperEvidenceLayerDrafts,
): Promise<{ sections: number; spans: number; cards: number; profiles: number }> {
  const sectionRows = drafts.sections.map((section) => ({
    stable_key: section.stableKey,
    feed_item_id: section.feedItemId,
    section_index: section.sectionIndex,
    section_path: section.sectionPath,
    section_type: section.sectionType,
    section_text: section.text,
    source_hash: section.sourceHash,
    parser_version: section.parserVersion,
  }));
  const sectionRowsJson = jsonArray(sectionRows);
  const cardRows = drafts.cards.map((card) => ({
    stable_key: card.stableKey,
    feed_item_id: card.feedItemId,
    primary_support_span_index: card.primarySupportSpanIndex,
    claim: card.claim,
    claim_type: card.claimType,
    support_span_indexes: card.supportSpanIndexes,
    section_path: card.sectionPath,
    entities: card.entities,
    methods: card.methods,
    datasets: card.datasets,
    metrics: card.metrics,
    numbers: card.numbers,
    aliases: card.aliases,
    confidence: card.confidence,
    verifier_status: card.verifierStatus,
    extractor_version: card.extractorVersion,
    source_hash: card.sourceHash,
  }));
  const cardRowsJson = jsonArray(cardRows);

  const rows = (await sqlClient`
    WITH deleted_cards AS (
      DELETE FROM paper_evidence_cards
      WHERE feed_item_id = ${drafts.profile.feedItemId}
      RETURNING id
    ),
    deleted_profiles AS (
      DELETE FROM paper_reader_profiles
      WHERE feed_item_id = ${drafts.profile.feedItemId}
        AND (SELECT COUNT(*) FROM deleted_cards) >= 0
      RETURNING id
    ),
    deleted_spans AS (
      DELETE FROM paper_evidence_spans
      WHERE feed_item_id = ${drafts.profile.feedItemId}
        AND (SELECT COUNT(*) FROM deleted_profiles) >= 0
      RETURNING id
    ),
    deleted_sections AS (
      DELETE FROM paper_sections
      WHERE feed_item_id = ${drafts.profile.feedItemId}
        AND (SELECT COUNT(*) FROM deleted_spans) >= 0
      RETURNING id
    ),
    deletion_barrier AS (
      SELECT
        (SELECT COUNT(*) FROM deleted_cards) AS deleted_cards,
        (SELECT COUNT(*) FROM deleted_profiles) AS deleted_profiles,
        (SELECT COUNT(*) FROM deleted_spans) AS deleted_spans,
        (SELECT COUNT(*) FROM deleted_sections) AS deleted_sections
    ),
    section_input AS (
      SELECT
        section.stable_key,
        section.feed_item_id,
        section.section_index,
        COALESCE(
          (
            SELECT array_agg(value ORDER BY ord)
            FROM jsonb_array_elements_text(COALESCE(section.section_path, '[]'::jsonb))
              WITH ORDINALITY AS elem(value, ord)
          ),
          ARRAY[]::text[]
        ) AS section_path,
        section.section_type,
        section.section_text AS text,
        section.source_hash,
        section.parser_version
      FROM jsonb_to_recordset(${sectionRowsJson}::jsonb) AS section(
        stable_key text,
        feed_item_id int,
        section_index int,
        section_path jsonb,
        section_type text,
        section_text text,
        source_hash text,
        parser_version text
      )
      CROSS JOIN deletion_barrier
    ),
    inserted_sections AS (
      INSERT INTO paper_sections (
        stable_key,
        feed_item_id,
        section_index,
        section_path,
        section_type,
        text,
        source_hash,
        parser_version
      )
      SELECT
        stable_key,
        feed_item_id,
        section_index,
        section_path,
        section_type,
        text,
        source_hash,
        parser_version
      FROM section_input
      RETURNING id, section_index
    ),
    span_input AS (
      SELECT *
      FROM UNNEST(
        ${drafts.spans.map((span) => span.stableKey)}::text[],
        ${drafts.spans.map((span) => span.feedItemId)}::int[],
        ${drafts.spans.map((span) => span.sectionIndex)}::int[],
        ${drafts.spans.map((span) => span.spanIndex)}::int[],
        ${drafts.spans.map((span) => span.spanType)}::text[],
        ${drafts.spans.map((span) => span.origin)}::text[],
        ${drafts.spans.map((span) => span.text)}::text[],
        ${drafts.spans.map((span) => span.normalizedText)}::text[],
        ${drafts.spans.map((span) => span.backingChunkId)}::int[],
        ${drafts.spans.map((span) => span.sourceHash)}::text[]
      ) AS input(
        stable_key,
        feed_item_id,
        section_index,
        span_index,
        span_type,
        origin,
        text,
        normalized_text,
        backing_chunk_id,
        source_hash
      )
    ),
    inserted_spans AS (
      INSERT INTO paper_evidence_spans (
        stable_key,
        feed_item_id,
        section_id,
        span_index,
        span_type,
        origin,
        text,
        normalized_text,
        backing_chunk_id,
        source_hash
      )
      SELECT
        span_input.stable_key,
        span_input.feed_item_id,
        inserted_sections.id,
        span_input.span_index,
        span_input.span_type,
        span_input.origin,
        span_input.text,
        span_input.normalized_text,
        span_input.backing_chunk_id,
        span_input.source_hash
      FROM span_input
      JOIN inserted_sections
        ON inserted_sections.section_index = span_input.section_index
      RETURNING id, span_index, text
    ),
    card_input AS (
      SELECT
        card.stable_key,
        card.feed_item_id,
        card.primary_support_span_index,
        card.claim,
        card.claim_type,
        COALESCE(
          (
            SELECT array_agg(value::int ORDER BY ord)
            FROM jsonb_array_elements_text(card.support_span_indexes)
              WITH ORDINALITY AS elem(value, ord)
          ),
          ARRAY[]::int[]
        ) AS support_span_indexes,
        COALESCE(
          (
            SELECT array_agg(value ORDER BY ord)
            FROM jsonb_array_elements_text(card.section_path)
              WITH ORDINALITY AS elem(value, ord)
          ),
          ARRAY[]::text[]
        ) AS section_path,
        COALESCE(
          (
            SELECT array_agg(value ORDER BY ord)
            FROM jsonb_array_elements_text(card.entities)
              WITH ORDINALITY AS elem(value, ord)
          ),
          ARRAY[]::text[]
        ) AS entities,
        COALESCE(
          (
            SELECT array_agg(value ORDER BY ord)
            FROM jsonb_array_elements_text(card.methods)
              WITH ORDINALITY AS elem(value, ord)
          ),
          ARRAY[]::text[]
        ) AS methods,
        COALESCE(
          (
            SELECT array_agg(value ORDER BY ord)
            FROM jsonb_array_elements_text(card.datasets)
              WITH ORDINALITY AS elem(value, ord)
          ),
          ARRAY[]::text[]
        ) AS datasets,
        COALESCE(
          (
            SELECT array_agg(value ORDER BY ord)
            FROM jsonb_array_elements_text(card.metrics)
              WITH ORDINALITY AS elem(value, ord)
          ),
          ARRAY[]::text[]
        ) AS metrics,
        COALESCE(
          (
            SELECT array_agg(value ORDER BY ord)
            FROM jsonb_array_elements_text(card.numbers)
              WITH ORDINALITY AS elem(value, ord)
          ),
          ARRAY[]::text[]
        ) AS numbers,
        COALESCE(
          (
            SELECT array_agg(value ORDER BY ord)
            FROM jsonb_array_elements_text(card.aliases)
              WITH ORDINALITY AS elem(value, ord)
          ),
          ARRAY[]::text[]
        ) AS aliases,
        card.confidence,
        card.verifier_status,
        card.extractor_version,
        card.source_hash
      FROM jsonb_to_recordset(${cardRowsJson}::jsonb) AS card(
        stable_key text,
        feed_item_id int,
        primary_support_span_index int,
        claim text,
        claim_type text,
        support_span_indexes jsonb,
        section_path jsonb,
        entities jsonb,
        methods jsonb,
        datasets jsonb,
        metrics jsonb,
        numbers jsonb,
        aliases jsonb,
        confidence double precision,
        verifier_status text,
        extractor_version text,
        source_hash text
      )
    ),
    inserted_cards AS (
      INSERT INTO paper_evidence_cards (
        stable_key,
        feed_item_id,
        primary_support_span_id,
        claim,
        claim_type,
        support_span_ids,
        section_path,
        entities,
        methods,
        datasets,
        metrics,
        numbers,
        aliases,
        confidence,
        verifier_status,
        extractor_version,
        source_hash
      )
      SELECT
        card_input.stable_key,
        card_input.feed_item_id,
        primary_span.id,
        card_input.claim,
        card_input.claim_type,
        support.support_span_ids,
        card_input.section_path,
        card_input.entities,
        card_input.methods,
        card_input.datasets,
        card_input.metrics,
        card_input.numbers,
        card_input.aliases,
        card_input.confidence,
        card_input.verifier_status,
        card_input.extractor_version,
        card_input.source_hash
      FROM card_input
      JOIN inserted_spans primary_span
        ON primary_span.span_index = card_input.primary_support_span_index
      JOIN LATERAL (
        SELECT COALESCE(array_agg(support_span.id ORDER BY support.ord), ARRAY[]::int[]) AS support_span_ids
        FROM unnest(card_input.support_span_indexes) WITH ORDINALITY AS support(span_index, ord)
        JOIN inserted_spans support_span
          ON support_span.span_index = support.span_index
      ) support ON TRUE
      WHERE cardinality(support.support_span_ids) > 0
      RETURNING id
    ),
    inserted_profile AS (
      INSERT INTO paper_reader_profiles (
        stable_key,
        feed_item_id,
        source_hash,
        profile_text,
        title_aliases,
        keyphrases,
        identity_anchors,
        parser_version,
        extractor_version
      )
      SELECT
        ${drafts.profile.stableKey},
        ${drafts.profile.feedItemId},
        ${drafts.profile.sourceHash},
        ${drafts.profile.profileText},
        ${drafts.profile.titleAliases}::text[],
        ${drafts.profile.keyphrases}::text[],
        ${drafts.profile.identityAnchors}::text[],
        ${drafts.profile.parserVersion},
        ${drafts.profile.extractorVersion}
      FROM deletion_barrier
      RETURNING id
    )
    SELECT
      (SELECT COUNT(*) FROM inserted_sections) AS sections,
      (SELECT COUNT(*) FROM inserted_spans) AS spans,
      (SELECT COUNT(*) FROM inserted_cards) AS cards,
      (SELECT COUNT(*) FROM inserted_profile) AS profiles
  `) as Array<{
    sections: number | string;
    spans: number | string;
    cards: number | string;
    profiles: number | string;
  }>;

  return {
    sections: toInteger(rows[0]?.sections) ?? 0,
    spans: toInteger(rows[0]?.spans) ?? 0,
    cards: toInteger(rows[0]?.cards) ?? 0,
    profiles: toInteger(rows[0]?.profiles) ?? 0,
  };
}

export async function preparePaperEvidenceLayerForFeedItem(
  sqlClient: SqlClient,
  item: MemoryBackfillFeedItem,
  options: RebuildPaperEvidenceLayerOptions = {},
): Promise<PreparedPaperEvidenceLayer> {
  options.signal?.throwIfAborted();
  const hasSourceText = Boolean(item.full_text?.trim() || item.content?.trim());
  if (!hasSourceText) {
    return {
      feedItemId: item.id,
      sourceHash: null,
      drafts: null,
      skipped: true,
      chunksRefreshed: false,
    };
  }

  let chunksRefreshed = false;
  if ((options.refreshChunks ?? true) && !options.dryRun) {
    const refreshResult = await refreshKnowledgeChunksForFeedItemIfStale(item);
    chunksRefreshed = refreshResult.refreshed;
  }
  options.signal?.throwIfAborted();

  const drafts = await buildPaperEvidenceLayerDrafts(sqlClient, item, {
    extractorMode: options.extractorMode,
    signal: options.signal,
  });
  options.signal?.throwIfAborted();
  validatePaperEvidenceLayerDrafts(drafts);
  return {
    feedItemId: item.id,
    sourceHash: drafts.sourceHash,
    drafts,
    skipped: false,
    chunksRefreshed,
  };
}

export async function publishPreparedPaperEvidenceLayer(
  sqlClient: SqlClient,
  prepared: PreparedPaperEvidenceLayer,
  options: PublishPreparedPaperEvidenceLayerOptions = {},
): Promise<RebuildPaperEvidenceLayerResult> {
  if (prepared.skipped || !prepared.drafts) {
    return {
      feedItemId: prepared.feedItemId,
      sourceHash: prepared.sourceHash,
      sections: 0,
      spans: 0,
      cards: 0,
      profiles: 0,
      skipped: true,
      chunksRefreshed: prepared.chunksRefreshed,
      embeddingInputCount: 0,
      embeddingFailedCount: 0,
    };
  }

  const drafts = prepared.drafts;
  validatePaperEvidenceLayerDrafts(drafts);
  const publishCounts = await publishPaperEvidenceLayerDrafts(sqlClient, drafts);
  if (
    publishCounts.sections <= 0 ||
    publishCounts.spans <= 0 ||
    publishCounts.cards <= 0 ||
    publishCounts.profiles <= 0
  ) {
    throw new Error(
      `paper evidence publish inserted insufficient rows: sections=${publishCounts.sections} spans=${publishCounts.spans} cards=${publishCounts.cards} profiles=${publishCounts.profiles}`,
    );
  }

  let embeddingInputCount = 0;
  let embeddingFailedCount = 0;
  if (
    (options.embedSpans ?? true) &&
    drafts.extractorMode === "llm" &&
    publishCounts.spans > 0
  ) {
    try {
      const insertedRows = (await sqlClient`
        SELECT id, text
        FROM paper_evidence_spans
        WHERE feed_item_id = ${prepared.feedItemId}
          AND source_hash = ${drafts.sourceHash}
        ORDER BY span_index ASC, id ASC
      `) as Array<{ id: number | string; text: string }>;
      const insertedSpans = insertedRows
        .map((span) => {
          const id = toInteger(span.id);
          return id == null ? null : { id, text: span.text };
        })
        .filter((entry): entry is { id: number; text: string } => entry != null);
      const embeddingResult = await embedInsertedPaperEvidenceSpans(
        sqlClient,
        insertedSpans,
      );
      embeddingInputCount = embeddingResult.embeddingInputCount;
      embeddingFailedCount = embeddingResult.embeddingFailedCount;
    } catch (error) {
      embeddingInputCount = publishCounts.spans;
      embeddingFailedCount = publishCounts.spans;
      console.error("paper_evidence_layer.embedding_lookup_failed", {
        feedItemId: prepared.feedItemId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    feedItemId: prepared.feedItemId,
    sourceHash: drafts.sourceHash,
    sections: publishCounts.sections,
    spans: publishCounts.spans,
    cards: publishCounts.cards,
    profiles: publishCounts.profiles,
    skipped: false,
    chunksRefreshed: prepared.chunksRefreshed,
    droppedSpans: drafts.droppedSpans,
    droppedClaims: drafts.droppedClaims,
    droppedAnchors: drafts.droppedAnchors,
    embeddingInputCount,
    embeddingFailedCount,
    embeddingIncomplete:
      drafts.extractorMode === "llm" &&
      publishCounts.spans > 0 &&
      (!(options.embedSpans ?? true) || embeddingFailedCount > 0),
    llmInputTokens: drafts.llmInputTokens,
    llmOutputTokens: drafts.llmOutputTokens,
  };
}

export async function rebuildPaperEvidenceLayerForFeedItem(
  sqlClient: SqlClient,
  item: MemoryBackfillFeedItem,
  options: RebuildPaperEvidenceLayerOptions = {},
): Promise<RebuildPaperEvidenceLayerResult> {
  const prepared = await preparePaperEvidenceLayerForFeedItem(
    sqlClient,
    item,
    options,
  );
  if (prepared.skipped || !prepared.drafts) {
    return {
      feedItemId: prepared.feedItemId,
      sourceHash: prepared.sourceHash,
      sections: 0,
      spans: 0,
      cards: 0,
      profiles: 0,
      skipped: true,
      chunksRefreshed: prepared.chunksRefreshed,
      embeddingInputCount: 0,
      embeddingFailedCount: 0,
    };
  }

  const drafts = prepared.drafts;
  if (options.dryRun) {
    return {
      feedItemId: item.id,
      sourceHash: drafts.sourceHash,
      sections: drafts.sections.length,
      spans: drafts.spans.length,
      cards: drafts.cards.length,
      profiles: 1,
      skipped: false,
      chunksRefreshed: prepared.chunksRefreshed,
      droppedSpans: drafts.droppedSpans,
      droppedClaims: drafts.droppedClaims,
      droppedAnchors: drafts.droppedAnchors,
      wouldEmbedCount: drafts.extractorMode === "llm" ? drafts.spans.length : 0,
      embeddingInputCount: 0,
      embeddingFailedCount: 0,
      embeddingIncomplete: false,
      llmInputTokens: drafts.llmInputTokens,
      llmOutputTokens: drafts.llmOutputTokens,
    };
  }

  options.signal?.throwIfAborted();
  return publishPreparedPaperEvidenceLayer(sqlClient, prepared);
}

function buildEvidenceSearchQuery({
  query,
  queryFacets = [],
  exactEvidencePhrases = [],
}: {
  query: string;
  queryFacets?: string[];
  exactEvidencePhrases?: string[];
}): string {
  const parts = unique(
    [query, ...exactEvidencePhrases, ...queryFacets]
      .map(normalizeFlat)
      .filter(Boolean),
    MAX_SEARCH_QUERY_PARTS,
  );
  return parts.join(" ").slice(0, MAX_SEARCH_QUERY_CHARS);
}

function textContainsPhrase(text: string, phrase: string): boolean {
  const normalizedText = normalizeKeyText(text);
  const normalizedPhrase = normalizeKeyText(phrase);
  return Boolean(normalizedPhrase) && normalizedText.includes(normalizedPhrase);
}

function significantQueryTerms(query: string): string[] {
  return unique(
    query
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9.+#_-]*/g) ?? [],
    18,
  ).filter((term) => term.length >= 4 && !EVIDENCE_STOPWORDS.has(term));
}

function rankEvidenceLayerRows({
  rows,
  query,
  exactEvidencePhrases,
}: {
  rows: PaperEvidenceLayerSearchRow[];
  query: string;
  exactEvidencePhrases: string[];
}): PaperEvidenceLayerSearchRow[] {
  const terms = significantQueryTerms(query);
  const queryNumbers = extractNumbers(query);

  return rows
    .map((row, index) => {
      const haystack = [
        row.snippet,
        row.paper_evidence.claim_type ?? "",
        ...(row.paper_evidence.section_path ?? []),
        ...(row.paper_evidence.numbers ?? []),
        ...(row.paper_evidence.metrics ?? []),
        ...(row.paper_evidence.methods ?? []),
        ...(row.paper_evidence.datasets ?? []),
        ...(row.paper_evidence.aliases ?? []),
      ].join(" ");
      const exactPhraseScore =
        exactEvidencePhrases.filter((phrase) => textContainsPhrase(haystack, phrase)).length * 30;
      const termScore = terms.filter((term) => textContainsPhrase(haystack, term)).length * 1.5;
      const numberScore =
        queryNumbers.filter((number) => textContainsPhrase(haystack, number)).length * 8;
      const cardScore = row.paper_evidence.card_id == null ? 0 : 4;
      const score = row.evidence_score + exactPhraseScore + termScore + numberScore + cardScore;
      return { row, index, score };
    })
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      const aRank = toNumber(a.row.fts_rank) ?? Number.POSITIVE_INFINITY;
      const bRank = toNumber(b.row.fts_rank) ?? Number.POSITIVE_INFINITY;
      if (aRank !== bRank) {
        return aRank - bRank;
      }
      return a.index - b.index;
    })
    .map(({ row }) => row);
}

export async function queryPaperEvidenceLayerRows({
  query,
  feedItemIds,
  paperCorpusScope,
  after,
  before,
  limitPerItem,
  queryFacets = [],
  exactEvidencePhrases = [],
}: {
  query: string;
  feedItemIds: number[];
  paperCorpusScope: PaperEvidenceLayerCorpusScope;
  after: string | null;
  before: string | null;
  limitPerItem: number;
  queryFacets?: string[];
  exactEvidencePhrases?: string[];
}): Promise<PaperEvidenceLayerSearchRow[]> {
  if (feedItemIds.length === 0) {
    return [];
  }

  const evidenceQuery = buildEvidenceSearchQuery({
    query,
    queryFacets,
    exactEvidencePhrases,
  });
  if (!evidenceQuery) {
    return [];
  }

  const rawRows = (await defaultSql`
    WITH search_query AS (
      SELECT
        plainto_tsquery('english', ${evidenceQuery}) AS exact_query,
        websearch_to_tsquery(
          'english',
          array_to_string(regexp_split_to_array(btrim(${evidenceQuery}), '[[:space:]]+'), ' OR ')
        ) AS fallback_query
    ),
    ranked AS (
      SELECT
        COALESCE(pes.backing_chunk_id, fallback_kc.id) AS id,
        pec.feed_item_id,
        COALESCE(kc.chunk_index, fallback_kc.chunk_index) AS chunk_index,
        fi.title,
        fi.author_name,
        fi.published_at,
        fi.url,
        pes.id AS span_id,
        pec.id AS card_id,
        ps.section_path,
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
        (
          ts_rank_cd(pes.text_tsv, search_query.exact_query) * 2.0 +
          ts_rank_cd(pes.text_tsv, search_query.fallback_query) +
          ts_rank_cd(pec.text_tsv, search_query.exact_query) * 2.4 +
          ts_rank_cd(pec.text_tsv, search_query.fallback_query) * 1.2 +
          pec.confidence * 1.5 +
          CASE ps.section_type
            WHEN 'result' THEN 1.2
            WHEN 'method' THEN 1.0
            WHEN 'limitation' THEN 0.9
            WHEN 'abstract' THEN 0.5
            ELSE 0
          END +
          CASE WHEN pes.text ~ '[0-9]' THEN 0.4 ELSE 0 END
        ) AS sql_score,
        ROW_NUMBER() OVER (
          PARTITION BY pec.feed_item_id
          ORDER BY
            (
              ts_rank_cd(pes.text_tsv, search_query.exact_query) * 2.0 +
              ts_rank_cd(pes.text_tsv, search_query.fallback_query) +
              ts_rank_cd(pec.text_tsv, search_query.exact_query) * 2.4 +
              ts_rank_cd(pec.text_tsv, search_query.fallback_query) * 1.2 +
              pec.confidence * 1.5 +
              CASE ps.section_type
                WHEN 'result' THEN 1.2
                WHEN 'method' THEN 1.0
                WHEN 'limitation' THEN 0.9
                WHEN 'abstract' THEN 0.5
                ELSE 0
              END +
              CASE WHEN pes.text ~ '[0-9]' THEN 0.4 ELSE 0 END
            ) DESC,
            pes.span_index ASC,
            pes.id ASC
        ) AS evidence_rank,
        fallback_kc.id AS fallback_chunk_id
      FROM paper_evidence_cards pec
      JOIN paper_evidence_spans pes ON pes.id = pec.primary_support_span_id
      JOIN paper_sections ps ON ps.id = pes.section_id
      JOIN feed_items fi ON fi.id = pec.feed_item_id
      LEFT JOIN knowledge_chunks kc ON kc.id = pes.backing_chunk_id
      LEFT JOIN LATERAL (
        SELECT fallback.id, fallback.chunk_index
        FROM knowledge_chunks fallback
        WHERE fallback.feed_item_id = pec.feed_item_id
        ORDER BY fallback.chunk_index ASC, fallback.id ASC
        LIMIT 1
      ) fallback_kc ON TRUE
      CROSS JOIN search_query
      WHERE pec.feed_item_id = ANY(${feedItemIds}::int[])
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
        AND (
          pes.text_tsv @@ search_query.exact_query
          OR pes.text_tsv @@ search_query.fallback_query
          OR pec.text_tsv @@ search_query.exact_query
          OR pec.text_tsv @@ search_query.fallback_query
        )
    )
    SELECT *
    FROM ranked
    WHERE evidence_rank <= ${Math.max(limitPerItem * 3, 12)}
    ORDER BY
      array_position(${feedItemIds}::int[], feed_item_id),
      evidence_rank ASC,
      span_id ASC
  `) as StoredPaperEvidenceLayerRow[];

  const rows = rawRows
    .map((row): PaperEvidenceLayerSearchRow | null => {
      const id = toInteger(row.id);
      const feedItemId = toInteger(row.feed_item_id);
      const spanId = toInteger(row.span_id);
      if (id == null || feedItemId == null || spanId == null) {
        return null;
      }

      const evidenceRank = toInteger(row.evidence_rank) ?? 1;
      const sqlScore = toNumber(row.sql_score) ?? 0;
      const cardId = toInteger(row.card_id);

      return {
        id,
        feed_item_id: feedItemId,
        chunk_index: toInteger(row.chunk_index),
        source_type: "paper",
        title: row.title,
        author_name: row.author_name,
        published_at: row.published_at,
        url: row.url,
        snippet: normalizeFlat(row.snippet),
        text: normalizeFlat(row.text),
        entity_labels: unique([
          ...(row.entities ?? []),
          ...(row.methods ?? []),
          ...(row.datasets ?? []),
          ...(row.metrics ?? []),
          ...(row.aliases ?? []),
        ], 32),
        fts_rank: evidenceRank,
        vec_rank: null,
        vec_distance: null,
        rrf_score: 1 / (SEARCH_RANK_CONSTANT + evidenceRank),
        expansion_query: evidenceQuery === query ? null : evidenceQuery,
        paper_evidence: {
          span_id: spanId,
          ...(cardId == null ? {} : { card_id: cardId }),
          origin: row.origin,
          section_path: row.section_path ?? [],
          span_type: row.span_type,
          ...(row.claim_type == null ? {} : { claim_type: row.claim_type }),
          entities: row.entities ?? [],
          methods: row.methods ?? [],
          datasets: row.datasets ?? [],
          metrics: row.metrics ?? [],
          numbers: row.numbers ?? [],
          aliases: row.aliases ?? [],
        },
        origin: row.origin,
        evidence_score: sqlScore,
      };
    })
    .filter((row): row is PaperEvidenceLayerSearchRow => row != null);

  const ranked = rankEvidenceLayerRows({
    rows,
    query,
    exactEvidencePhrases,
  });

  const counts = new Map<number, number>();
  return ranked.filter((row) => {
    const count = counts.get(row.feed_item_id) ?? 0;
    if (count >= limitPerItem) {
      return false;
    }
    counts.set(row.feed_item_id, count + 1);
    return true;
  });
}

export function isPaperEvidenceLayerEnabled(
  env: { PAPER_EVIDENCE_LAYER_ENABLED?: string } = process.env as {
    PAPER_EVIDENCE_LAYER_ENABLED?: string;
  },
): boolean {
  return env.PAPER_EVIDENCE_LAYER_ENABLED === "true";
}
