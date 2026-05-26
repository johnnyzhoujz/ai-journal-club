import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import Anthropic from "@anthropic-ai/sdk";

import type {
  PaperEvidenceClaimType,
  PaperEvidenceSpanType,
  ParsedPaperEvidenceSection,
} from "@/lib/paper-evidence-layer";

const DEFAULT_LLM_EXTRACTOR_MODEL = "claude-haiku-4-5-20251001";
const MAX_LLM_SOURCE_CANDIDATES = 1_500;
const PAPER_EVIDENCE_TOOL_NAME = "record_paper_evidence";
const DEFAULT_PROMPT_CAPTURE_DIR = path.join(
  process.cwd(),
  "tmp",
  "paper-evidence-extractor-prompts",
);

export interface PaperEvidenceLlmExtractorEnv {
  PAPER_EVIDENCE_LAYER_LLM_EXTRACTOR_ENABLED?: string;
  PAPER_EVIDENCE_LAYER_LLM_MODEL?: string;
  PAPER_EVIDENCE_LAYER_CAPTURE_PROMPT?: string;
  PAPER_EVIDENCE_LAYER_CAPTURE_PROMPT_DIR?: string;
  ANTHROPIC_API_KEY?: string;
}

export interface LlmPaperProposition {
  start: number;
  end: number;
  text: string;
  section_index?: number;
}

export interface LlmPaperListOrTableBlock {
  start: number;
  end: number;
  text: string;
  section_index?: number;
  block_kind: "list" | "table" | "table_row" | "figure_caption";
}

export interface LlmPaperClaim {
  claim: string;
  claim_type: PaperEvidenceClaimType;
  primary_support_span_ref: number;
  support_span_refs: number[];
  entities?: string[];
  methods?: string[];
  datasets?: string[];
  metrics?: string[];
  numbers?: string[];
  aliases?: string[];
  confidence: number;
}

export interface LlmCoinedTermAnchor {
  canonical: string;
  aliases?: string[];
  anchor_type:
    | "system"
    | "architecture"
    | "method"
    | "benchmark"
    | "dataset"
    | "concept";
  support_span_ref: number;
}

export interface LlmPaperEvidenceExtraction {
  propositions?: LlmPaperProposition[];
  list_table_blocks?: LlmPaperListOrTableBlock[];
  claims?: LlmPaperClaim[];
  coined_terms?: LlmCoinedTermAnchor[];
}

export interface AcceptedLlmPaperEvidenceSpan {
  llmRef: number;
  sectionIndex: number;
  sourceStart: number;
  sourceEnd: number;
  spanType: PaperEvidenceSpanType;
  text: string;
  normalizedText: string;
}

export interface AcceptedLlmPaperEvidenceClaim {
  claim: string;
  claimType: PaperEvidenceClaimType;
  primarySupportSpanIndex: number;
  supportSpanIndexes: number[];
  entities: string[];
  methods: string[];
  datasets: string[];
  metrics: string[];
  numbers: string[];
  aliases: string[];
  confidence: number;
}

export interface ValidatedLlmPaperEvidenceOutput {
  acceptedSpans: AcceptedLlmPaperEvidenceSpan[];
  acceptedClaims: AcceptedLlmPaperEvidenceClaim[];
  acceptedCoinedTermAnchors: string[];
  droppedSpanCount: number;
  droppedClaimCount: number;
  droppedAnchorCount: number;
  emittedCandidateCount: number;
}

export interface LlmPaperEvidencePromptInput {
  feed_item_id: number;
  title: string | null;
  external_id: string | null;
  sections: Array<{
    section_index: number;
    section_path: string[];
    section_type: string;
    text: string;
  }>;
  full_text: string;
}

export interface LlmPaperEvidenceExtractionResult {
  extraction: LlmPaperEvidenceExtraction;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

type LlmPaperSourceSpanCandidate = Pick<
  LlmPaperProposition,
  "start" | "end" | "text" | "section_index"
>;

type LlmPaperClaimWithFallbackSource = Partial<LlmPaperClaim> & {
  source_span?: LlmPaperSourceSpanCandidate;
};

type LlmCoinedTermAnchorWithFallbackSource = Partial<LlmCoinedTermAnchor> & {
  term?: string;
  source_span?: LlmPaperSourceSpanCandidate;
};

function canonicalSourceWhitespace(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function normalizeFlat(value: string): string {
  return canonicalSourceWhitespace(value).replace(/\s+/g, " ").trim();
}

function normalizeKey(value: string): string {
  return normalizeFlat(value).toLowerCase();
}

function unique(values: unknown, limit = 48): string[] {
  const sourceValues = Array.isArray(values) ? values : [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of sourceValues) {
    if (typeof value !== "string") {
      continue;
    }
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

function clampConfidence(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value));
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.max(0, Math.min(1, parsed));
}

function isValidClaimType(value: string): value is PaperEvidenceClaimType {
  return (
    value === "contribution" ||
    value === "method" ||
    value === "dataset" ||
    value === "benchmark" ||
    value === "metric" ||
    value === "result" ||
    value === "limitation" ||
    value === "comparison" ||
    value === "implementation" ||
    value === "unknown"
  );
}

const CLAIM_SUPPORT_STOPWORDS = new Set([
  "about",
  "across",
  "after",
  "also",
  "because",
  "being",
  "between",
  "compared",
  "contains",
  "could",
  "during",
  "from",
  "have",
  "into",
  "more",
  "only",
  "over",
  "paper",
  "than",
  "that",
  "their",
  "them",
  "then",
  "there",
  "these",
  "this",
  "through",
  "using",
  "with",
  "while",
]);

function supportTokens(value: string): string[] {
  const tokens = value.toLowerCase().match(/[a-z0-9][a-z0-9.+#_-]*/g) ?? [];
  return unique(
    tokens.filter((token) => token.length >= 4 && !CLAIM_SUPPORT_STOPWORDS.has(token)),
    80,
  );
}

function supportNumbers(value: string): string[] {
  return unique(value.match(/\b\d+(?:,\d{3})*(?:\.\d+)?%?\b/g) ?? [], 24);
}

function claimIsSupportedBySpan(claim: string, spanText: string): boolean {
  const claimNumberValues = supportNumbers(claim);
  if (
    claimNumberValues.length > 0 &&
    !claimNumberValues.every((number) => spanText.includes(number))
  ) {
    return false;
  }

  const claimTerms = supportTokens(claim);
  if (claimTerms.length === 0) {
    return true;
  }
  const spanTerms = new Set(supportTokens(spanText));
  const overlap = claimTerms.filter((term) => spanTerms.has(term)).length;
  const coverage = overlap / claimTerms.length;
  return overlap >= 4 || coverage >= 0.45;
}

function spanTypeForBlock(blockKind: LlmPaperListOrTableBlock["block_kind"]): PaperEvidenceSpanType {
  return blockKind === "figure_caption" ? "figure_caption" : "table_row";
}

function candidateCount(extraction: LlmPaperEvidenceExtraction): number {
  return (extraction.propositions?.length ?? 0) + (extraction.list_table_blocks?.length ?? 0);
}

function sectionForCandidate(
  candidate: { section_index?: number },
  sections: ParsedPaperEvidenceSection[],
): ParsedPaperEvidenceSection | null {
  if (candidate.section_index == null) {
    return null;
  }
  return (
    sections.find((section) => section.sectionIndex === candidate.section_index) ?? null
  );
}

function sourceSpanCandidate(value: unknown): LlmPaperSourceSpanCandidate | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Partial<LlmPaperSourceSpanCandidate>;
  const start = candidate.start;
  const end = candidate.end;
  if (
    typeof start !== "number" ||
    typeof end !== "number" ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    typeof candidate.text !== "string"
  ) {
    return null;
  }
  return {
    start,
    end,
    text: candidate.text,
    section_index: Number.isInteger(candidate.section_index)
      ? candidate.section_index
      : undefined,
  };
}

function validateCandidateRange({
  fullText,
  candidate,
}: {
  fullText: string;
  candidate: { start: number; end: number; text: string };
}): { sourceStart: number; sourceEnd: number; text: string; normalizedText: string } | null {
  if (
    !Number.isInteger(candidate.start) ||
    !Number.isInteger(candidate.end) ||
    typeof candidate.text !== "string" ||
    candidate.start < 0 ||
    candidate.end > fullText.length ||
    candidate.start >= candidate.end
  ) {
    return null;
  }

  const sourceSlice = fullText.slice(candidate.start, candidate.end);
  let sourceStart = candidate.start;
  let sourceEnd = candidate.end;
  let acceptedSourceSlice = sourceSlice;

  if (canonicalSourceWhitespace(sourceSlice) !== canonicalSourceWhitespace(candidate.text)) {
    const exactStart = fullText.indexOf(candidate.text);
    if (exactStart < 0 || exactStart !== fullText.lastIndexOf(candidate.text)) {
      return null;
    }
    sourceStart = exactStart;
    sourceEnd = exactStart + candidate.text.length;
    acceptedSourceSlice = fullText.slice(sourceStart, sourceEnd);
  }

  const text = normalizeFlat(acceptedSourceSlice);
  if (!text) {
    return null;
  }
  return { sourceStart, sourceEnd, text, normalizedText: normalizeKey(text) };
}

export function isPaperEvidenceLlmExtractorEnabled(
  env: Pick<
    PaperEvidenceLlmExtractorEnv,
    "PAPER_EVIDENCE_LAYER_LLM_EXTRACTOR_ENABLED"
  > = process.env as Pick<
    PaperEvidenceLlmExtractorEnv,
    "PAPER_EVIDENCE_LAYER_LLM_EXTRACTOR_ENABLED"
  >,
): boolean {
  return env.PAPER_EVIDENCE_LAYER_LLM_EXTRACTOR_ENABLED === "true";
}

export function buildLlmPaperEvidencePromptInput({
  feedItemId,
  title,
  externalId,
  fullText,
  sections,
}: {
  feedItemId: number;
  title?: string | null;
  externalId?: string | null;
  fullText: string;
  sections: ParsedPaperEvidenceSection[];
}): LlmPaperEvidencePromptInput {
  return {
    feed_item_id: feedItemId,
    title: title ?? null,
    external_id: externalId ?? null,
    sections: sections.map((section) => ({
      section_index: section.sectionIndex,
      section_path: section.sectionPath,
      section_type: section.sectionType,
      text: section.text,
    })),
    full_text: fullText,
  };
}

export function validateLlmPaperEvidenceOutput({
  fullText,
  sections,
  extraction,
}: {
  feedItemId: number;
  fullText: string;
  sections: ParsedPaperEvidenceSection[];
  extraction: LlmPaperEvidenceExtraction;
}): ValidatedLlmPaperEvidenceOutput {
  const emittedCandidateCount = candidateCount(extraction);
  if (emittedCandidateCount > MAX_LLM_SOURCE_CANDIDATES) {
    throw new Error(
      `Malformed paper evidence extractor output: ${emittedCandidateCount} source candidates exceeds ${MAX_LLM_SOURCE_CANDIDATES}`,
    );
  }

  const acceptedSpans: AcceptedLlmPaperEvidenceSpan[] = [];
  const refToAcceptedSpanIndex = new Map<number, number>();
  const normalizedSeenByType = new Set<string>();
  let droppedSpanCount = 0;

  const candidates: Array<{
    llmRef: number;
    candidate: LlmPaperProposition | LlmPaperListOrTableBlock;
    spanType: PaperEvidenceSpanType;
  }> = [
    ...(extraction.propositions ?? []).map((candidate, index) => ({
      llmRef: index,
      candidate,
      spanType: "sentence" as const,
    })),
    ...(extraction.list_table_blocks ?? []).map((candidate, index) => ({
      llmRef: (extraction.propositions?.length ?? 0) + index,
      candidate,
      spanType: spanTypeForBlock(candidate.block_kind),
    })),
  ];
  let nextLlmRef = candidates.length;
  const fallbackClaimRefs = new Map<number, number>();
  const fallbackAnchorRefs = new Map<number, number>();

  (extraction.claims ?? []).forEach((claim, index) => {
    const fallback = sourceSpanCandidate(
      (claim as LlmPaperClaimWithFallbackSource).source_span,
    );
    if (!fallback) {
      return;
    }
    const llmRef = nextLlmRef;
    nextLlmRef += 1;
    fallbackClaimRefs.set(index, llmRef);
    candidates.push({
      llmRef,
      candidate: fallback,
      spanType: "sentence",
    });
  });

  (extraction.coined_terms ?? []).forEach((anchor, index) => {
    const fallback = sourceSpanCandidate(
      (anchor as LlmCoinedTermAnchorWithFallbackSource).source_span,
    );
    if (!fallback) {
      return;
    }
    const llmRef = nextLlmRef;
    nextLlmRef += 1;
    fallbackAnchorRefs.set(index, llmRef);
    candidates.push({
      llmRef,
      candidate: fallback,
      spanType: "sentence",
    });
  });

  for (const { llmRef, candidate, spanType } of candidates) {
    const section = sectionForCandidate(candidate, sections);
    if (section?.sectionType === "references") {
      droppedSpanCount += 1;
      continue;
    }

    const valid = validateCandidateRange({ fullText, candidate });
    if (!valid) {
      droppedSpanCount += 1;
      continue;
    }

    const dedupeKey = `${spanType}:${valid.normalizedText}`;
    const existingIndex = acceptedSpans.findIndex(
      (span) => `${span.spanType}:${span.normalizedText}` === dedupeKey,
    );
    if (existingIndex >= 0) {
      refToAcceptedSpanIndex.set(llmRef, existingIndex);
      continue;
    }
    if (normalizedSeenByType.has(dedupeKey)) {
      droppedSpanCount += 1;
      continue;
    }
    normalizedSeenByType.add(dedupeKey);

    const acceptedIndex = acceptedSpans.length;
    acceptedSpans.push({
      llmRef,
      sectionIndex: section?.sectionIndex ?? candidate.section_index ?? 0,
      sourceStart: valid.sourceStart,
      sourceEnd: valid.sourceEnd,
      spanType,
      text: valid.text,
      normalizedText: valid.normalizedText,
    });
    refToAcceptedSpanIndex.set(llmRef, acceptedIndex);
  }

  const acceptedClaims: AcceptedLlmPaperEvidenceClaim[] = [];
  let droppedClaimCount = 0;
  for (const [claimIndex, claim] of (extraction.claims ?? []).entries()) {
    const fallbackRef = fallbackClaimRefs.get(claimIndex);
    const candidatePrimaryRefs = uniqueNumberArray([
      ...(fallbackRef == null ? [] : [fallbackRef]),
      ...(Number.isInteger(claim.primary_support_span_ref)
        ? [claim.primary_support_span_ref]
        : []),
    ]);
    const claimType =
      typeof claim?.claim_type === "string" && isValidClaimType(claim.claim_type)
        ? claim.claim_type
        : "unknown";
    if (
      typeof claim?.claim !== "string" ||
      candidatePrimaryRefs.length === 0 ||
      (claim.support_span_refs != null &&
        !Array.isArray(claim.support_span_refs) &&
        fallbackRef == null)
    ) {
      droppedClaimCount += 1;
      continue;
    }
    const primaryIndex = candidatePrimaryRefs
      .map((ref) => refToAcceptedSpanIndex.get(ref))
      .find(
        (spanIndex): spanIndex is number =>
          spanIndex != null &&
          claimIsSupportedBySpan(claim.claim, acceptedSpans[spanIndex]?.text ?? ""),
      );
    const supportSpanRefs = uniqueNumberArray(
      Array.isArray(claim.support_span_refs) ? claim.support_span_refs : [],
    );
    const supportIndexes = supportSpanRefs
      .map((ref) => refToAcceptedSpanIndex.get(ref))
      .filter((spanIndex): spanIndex is number => spanIndex != null);
    const supportRefsValid = supportIndexes.length === supportSpanRefs.length;
    if (
      primaryIndex == null ||
      (!supportRefsValid && fallbackRef == null)
    ) {
      droppedClaimCount += 1;
      continue;
    }
    acceptedClaims.push({
      claim: normalizeFlat(claim.claim),
      claimType,
      primarySupportSpanIndex: primaryIndex,
      supportSpanIndexes: uniqueNumberArray([primaryIndex, ...supportIndexes]),
      entities: unique(claim.entities ?? []),
      methods: unique(claim.methods ?? []),
      datasets: unique(claim.datasets ?? []),
      metrics: unique(claim.metrics ?? []),
      numbers: unique(claim.numbers ?? []),
      aliases: unique(claim.aliases ?? []),
      confidence: clampConfidence(claim.confidence),
    });
  }

  const acceptedCoinedTermAnchors: string[] = [];
  let droppedAnchorCount = 0;
  for (const [anchorIndex, anchor] of (extraction.coined_terms ?? []).entries()) {
    const fallbackAnchor = anchor as LlmCoinedTermAnchorWithFallbackSource;
    const canonical =
      typeof fallbackAnchor.canonical === "string"
        ? fallbackAnchor.canonical
        : typeof fallbackAnchor.term === "string"
          ? fallbackAnchor.term
          : null;
    const supportSpanRef = Number.isInteger(anchor.support_span_ref)
      ? anchor.support_span_ref
      : fallbackAnchorRefs.get(anchorIndex);
    if (
      canonical == null ||
      supportSpanRef == null ||
      refToAcceptedSpanIndex.get(supportSpanRef) == null
    ) {
      droppedAnchorCount += 1;
      continue;
    }
    acceptedCoinedTermAnchors.push(
      canonical,
      ...unique(anchor.aliases ?? []),
    );
  }

  return {
    acceptedSpans,
    acceptedClaims,
    acceptedCoinedTermAnchors: unique(acceptedCoinedTermAnchors, 80),
    droppedSpanCount,
    droppedClaimCount,
    droppedAnchorCount,
    emittedCandidateCount,
  };
}

function uniqueNumberArray(values: unknown): number[] {
  const sourceValues = Array.isArray(values) ? values : [];
  const result: number[] = [];
  const seen = new Set<number>();
  for (const value of sourceValues) {
    if (!Number.isInteger(value) || seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

function extractAnthropicText(response: Anthropic.Message): string {
  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function normalizeExtractionPayload(parsed: unknown): LlmPaperEvidenceExtraction {
  const payload =
    parsed && typeof parsed === "object"
      ? (parsed as LlmPaperEvidenceExtraction)
      : {};
  return {
    propositions: Array.isArray(payload.propositions) ? payload.propositions : [],
    list_table_blocks: Array.isArray(payload.list_table_blocks)
      ? payload.list_table_blocks
      : [],
    claims: Array.isArray(payload.claims) ? payload.claims : [],
    coined_terms: Array.isArray(payload.coined_terms) ? payload.coined_terms : [],
  };
}

function parseJsonPayload(text: string): LlmPaperEvidenceExtraction {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const raw = fenced
    ? fenced[1]
    : trimmed.slice(
        Math.max(0, trimmed.indexOf("{")),
        trimmed.lastIndexOf("}") >= 0 ? trimmed.lastIndexOf("}") + 1 : undefined,
      );
  return normalizeExtractionPayload(JSON.parse(raw));
}

function extractAnthropicToolInput(response: Anthropic.Message): unknown | null {
  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock =>
      block.type === "tool_use" && block.name === PAPER_EVIDENCE_TOOL_NAME,
  );
  return toolUse?.input ?? null;
}

async function createExtractorMessage(
  anthropic: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
  signal?: AbortSignal,
): Promise<Anthropic.Message> {
  const messages = anthropic.messages as Anthropic["messages"] & {
    stream?: (
      params: Anthropic.MessageCreateParamsNonStreaming,
      options?: { signal?: AbortSignal },
    ) => { finalMessage: () => Promise<Anthropic.Message> };
  };
  if (typeof messages.stream === "function") {
    return messages.stream(params, signal ? { signal } : undefined).finalMessage();
  }
  return messages.create(params, signal ? { signal } : undefined);
}

const paperEvidenceExtractionTool: Anthropic.Tool = {
  name: PAPER_EVIDENCE_TOOL_NAME,
  description:
    "Record source-grounded paper evidence as verbatim spans, whole list/table blocks, typed claims, and coined terms.",
  input_schema: {
    type: "object",
    properties: {
      propositions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            start: { type: "integer" },
            end: { type: "integer" },
            text: { type: "string" },
            section_index: { type: "integer" },
          },
          required: ["start", "end", "text"],
        },
      },
      list_table_blocks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            start: { type: "integer" },
            end: { type: "integer" },
            text: { type: "string" },
            section_index: { type: "integer" },
            block_kind: {
              type: "string",
              enum: ["list", "table", "table_row", "figure_caption"],
            },
          },
          required: ["start", "end", "text", "block_kind"],
        },
      },
      claims: {
        type: "array",
        items: {
          type: "object",
          properties: {
            claim: { type: "string" },
            claim_type: {
              type: "string",
              enum: [
                "contribution",
                "method",
                "dataset",
                "benchmark",
                "metric",
                "result",
                "limitation",
                "comparison",
                "implementation",
                "unknown",
              ],
            },
            primary_support_span_ref: { type: "integer" },
            support_span_refs: {
              type: "array",
              items: { type: "integer" },
            },
            source_span: {
              type: "object",
              properties: {
                start: { type: "integer" },
                end: { type: "integer" },
                text: { type: "string" },
                section_index: { type: "integer" },
              },
              required: ["start", "end", "text"],
            },
            entities: { type: "array", items: { type: "string" } },
            methods: { type: "array", items: { type: "string" } },
            datasets: { type: "array", items: { type: "string" } },
            metrics: { type: "array", items: { type: "string" } },
            numbers: { type: "array", items: { type: "string" } },
            aliases: { type: "array", items: { type: "string" } },
            confidence: { type: "number" },
          },
          required: ["claim"],
        },
      },
      coined_terms: {
        type: "array",
        items: {
          type: "object",
          properties: {
            canonical: { type: "string" },
            term: { type: "string" },
            aliases: { type: "array", items: { type: "string" } },
            anchor_type: {
              type: "string",
              enum: ["system", "architecture", "method", "benchmark", "dataset", "concept"],
            },
            support_span_ref: { type: "integer" },
            source_span: {
              type: "object",
              properties: {
                start: { type: "integer" },
                end: { type: "integer" },
                text: { type: "string" },
                section_index: { type: "integer" },
              },
              required: ["start", "end", "text"],
            },
          },
        },
      },
    },
    required: ["propositions", "list_table_blocks", "claims", "coined_terms"],
  },
};

function getLlmExtractorModel(env: PaperEvidenceLlmExtractorEnv): string {
  return env.PAPER_EVIDENCE_LAYER_LLM_MODEL?.trim() || DEFAULT_LLM_EXTRACTOR_MODEL;
}

export function buildLlmExtractorUserMessage(
  promptInput: LlmPaperEvidencePromptInput,
): string {
  return [
    "Return exactly this JSON shape:",
    "{",
    '  "propositions": [{"start": 0, "end": 0, "text": "...", "section_index": 0}],',
    '  "list_table_blocks": [{"start": 0, "end": 0, "text": "...", "section_index": 0, "block_kind": "list"}],',
    '  "claims": [{"claim": "...", "claim_type": "contribution", "primary_support_span_ref": 0, "support_span_refs": [0], "source_span": {"start": 0, "end": 0, "text": "...", "section_index": 0}, "entities": [], "methods": [], "datasets": [], "metrics": [], "numbers": [], "aliases": [], "confidence": 0.8}],',
    '  "coined_terms": [{"canonical": "...", "aliases": [], "anchor_type": "system", "support_span_ref": 0, "source_span": {"start": 0, "end": 0, "text": "...", "section_index": 0}}]',
    "}",
    "",
    "Rules:",
    "- Be exhaustive on propositions. Extract every sentence that contains a numeric result, a named system/method/dataset/benchmark/metric, a definition, an explicit contribution, a limitation, or a quantitative claim. Do not select or skim. For a normal full paper, aim for 150 to 300 propositions plus important list/table blocks. For short abstracts or very short source text, emit as many useful source spans as exist.",
    "- Cover the title/abstract, explicit contributions, system or method definitions, datasets, benchmarks, metrics/results with numbers, limitations, and implementation details.",
    "- Every proposition.text and every nested source_span.text MUST be a byte-exact contiguous substring of full_text with correct start/end offsets. Do not paraphrase, do not normalize whitespace, do not correct punctuation. If the source is awkward, copy it verbatim anyway.",
    "- Prefer self-contained 5- to 35-word source spans so short defining spans like \"we introduce X, a Y\" survive. Use longer exact spans when needed for a complete numeric claim, definition, or enumeration.",
    "- Whole-sentence preservation. Each proposition MUST begin at the sentence's actual start in source and end at the next sentence-ending punctuation. Do not start a proposition mid-sentence, even if the leading clause looks like a transition such as \"To address X, we introduce Y\". Do not split a sentence at internal commas, dashes, parentheses, or sub-clause boundaries. Compound sentences with embedded clauses such as \"we propose Y, a framework in which X, termed Z, serves as W\" are ONE proposition, not several. This rule overrides the 5- to 35-word width target.",
    "- Transition and definition sentence coverage. Any sentence that introduces a named contribution, defines a term, or states a relationship between a gap and a solution is REQUIRED to appear as a verbatim proposition, including title/abstract openers such as \"we propose X, a framework in which Y, termed Z, serves as W\".",
    "- proposition refs are zero-based indexes into propositions followed by list_table_blocks.",
    "- claims.primary_support_span_ref and coined_terms.support_span_ref must use those zero-based refs.",
    "- claims.source_span must duplicate the exact source span that supports the claim; it is used to validate the ref.",
    "- claim_type must be one of contribution, method, dataset, benchmark, metric, result, limitation, comparison, implementation.",
    "- list/table blocks should preserve related bullets, table rows, and enumerations whole.",
    "- Named-entity coverage (REQUIRED). Every named system, method, architecture, dataset, and benchmark introduced or evaluated by this paper MUST appear in at least one claim's entities/methods/datasets/aliases array AND as a coined_terms entry. Capture the paper's model/system name, framework name, dataset name(s), benchmark name(s), and any named architectures. Do not omit any. Populate the corresponding array: systems and architectures into entities; methods into methods; datasets and benchmarks into datasets; and the short canonical name (with capitalization preserved) into aliases as well.",
    "- Every coined_terms entry MUST include a source_span — a byte-exact verbatim substring of full_text that defines or introduces the term — even when also providing a support_span_ref. The source_span is the salvage path if the referenced proposition fails byte-exact validation.",
    "- Return only the JSON object, with no markdown fence.",
    "",
    "Paper input JSON:",
    JSON.stringify(promptInput),
  ].join("\n");
}

export async function extractPaperEvidenceWithLlm({
  feedItemId,
  title,
  externalId,
  fullText,
  sections,
  signal,
  env = process.env as PaperEvidenceLlmExtractorEnv,
}: {
  feedItemId: number;
  title?: string | null;
  externalId?: string | null;
  fullText: string;
  sections: ParsedPaperEvidenceSection[];
  signal?: AbortSignal;
  env?: PaperEvidenceLlmExtractorEnv;
}): Promise<LlmPaperEvidenceExtractionResult> {
  signal?.throwIfAborted();
  if (!env.ANTHROPIC_API_KEY?.trim()) {
    throw new Error(
      "ANTHROPIC_API_KEY is required for paper semantic evidence extraction",
    );
  }

  const promptInput = buildLlmPaperEvidencePromptInput({
    feedItemId,
    title,
    externalId,
    fullText,
    sections,
  });
  const model = getLlmExtractorModel(env);
  const userMessageContent = buildLlmExtractorUserMessage(promptInput);

  if (env.PAPER_EVIDENCE_LAYER_CAPTURE_PROMPT === "1") {
    const captureDir =
      env.PAPER_EVIDENCE_LAYER_CAPTURE_PROMPT_DIR?.trim() ||
      DEFAULT_PROMPT_CAPTURE_DIR;
    await mkdir(captureDir, { recursive: true });
    await writeFile(
      path.join(captureDir, `${feedItemId}.txt`),
      userMessageContent,
      "utf8",
    );
  }

  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const response = await createExtractorMessage(anthropic, {
    model,
    max_tokens: 32_768,
    temperature: 0,
    tools: [paperEvidenceExtractionTool],
    tool_choice: {
      type: "tool",
      name: PAPER_EVIDENCE_TOOL_NAME,
      disable_parallel_tool_use: true,
    },
    system:
      "Extract source-grounded paper evidence. Use the record_paper_evidence tool. Every proposition, block, claim.source_span, and coined_terms.source_span must be a verbatim contiguous substring of full_text with start/end offsets counted from the first character of full_text. Do not summarize source spans.",
    messages: [
      {
        role: "user",
        content: userMessageContent,
      },
    ],
  }, signal);
  signal?.throwIfAborted();

  return {
    extraction: normalizeExtractionPayload(
      extractAnthropicToolInput(response) ?? parseJsonPayload(extractAnthropicText(response)),
    ),
    model,
    inputTokens: response.usage?.input_tokens ?? null,
    outputTokens: response.usage?.output_tokens ?? null,
  };
}
