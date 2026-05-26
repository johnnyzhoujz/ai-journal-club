import { createHash } from "node:crypto";
import { sql } from "@/lib/db";
import {
  embedMemoryTexts,
  formatPgVectorLiteral,
  isMemoryVectorEnabled,
} from "@/lib/memory-embeddings";
import type {
  CorpusTier,
  FeedItemSourceType,
  PaperCorpusTierMetadata,
  PaperMeta,
} from "@/lib/schema";

const DEFAULT_BACKFILL_LIMIT = 25;
const MAX_BACKFILL_LIMIT = 100;
const DEFAULT_CHUNK_TOKEN_LIMIT = 700;
const DEFAULT_CHUNK_TOKEN_OVERLAP = 80;
const DEFAULT_MAX_CHUNKS_PER_ITEM = 40;

export interface MemoryBackfillFeedItem {
  id: number;
  source_type: FeedItemSourceType;
  title: string | null;
  content: string;
  author_name: string;
  author_handle: string | null;
  published_at: string | Date | null;
  paper_meta: PaperMeta | null;
  full_text?: string | null;
  full_text_source?: "arxiv_html" | "hf_page" | null;
  corpus_tier?: CorpusTier | null;
  tier_metadata_json?: PaperCorpusTierMetadata | null;
}

export interface KnowledgeMemoryDocument {
  text: string;
  sourceKind: string;
  sourceHash: string;
}

export interface KnowledgeChunkDraft {
  feedItemId: number;
  chunkIndex: number;
  sourceType: FeedItemSourceType;
  title: string | null;
  authorName: string;
  authorHandle: string | null;
  publishedAt: string | Date | null;
  text: string;
  retrievalText: string;
  tokenCount: number;
  entityLabels: string[];
  memorySourceHash: string;
  memorySourceKind: string;
}

export interface KnowledgeChunkRetrievalTextInput {
  sourceType: FeedItemSourceType;
  title: string | null;
  authorName: string;
  authorHandle?: string | null;
  publishedAt: string | Date | null;
  text: string;
  entityLabels?: string[] | null;
  paperMeta?: PaperMeta | null;
}

export interface BackfillKnowledgeChunksOptions {
  limit?: number;
  afterId?: number | null;
  beforeId?: number | null;
  feedItemId?: number | null;
  refreshExisting?: boolean;
  chunkTokenLimit?: number;
  chunkTokenOverlap?: number;
  maxChunksPerItem?: number;
}

export interface BackfillKnowledgeChunksResult {
  selectedItemCount: number;
  upsertedChunkCount: number;
  skippedItemCount: number;
  failedItemCount: number;
  lastFeedItemId: number | null;
  errors: string[];
}

export interface WriteKnowledgeChunksForFeedItemResult {
  upsertedChunkCount: number;
  skippedItem: boolean;
}

export interface RefreshKnowledgeChunksForFeedItemResult
  extends WriteKnowledgeChunksForFeedItemResult {
  sourceHash: string;
  sourceKind: string;
}

export interface RefreshKnowledgeChunksForFeedItemIfStaleResult
  extends RefreshKnowledgeChunksForFeedItemResult {
  refreshed: boolean;
}

interface EmbeddedKnowledgeChunkDraft extends KnowledgeChunkDraft {
  embedding: number[] | null;
  embeddingModel: string | null;
}

interface PaperSection {
  path: string | null;
  text: string;
}

function clampPositiveInteger(
  value: number | null | undefined,
  fallback: number,
  max: number,
): number {
  if (!Number.isInteger(value) || value == null || value <= 0) {
    return fallback;
  }
  return Math.min(value, max);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeOptionalText(
  value: string | Date | number | null | undefined,
): string | null {
  if (!value) {
    return null;
  }

  const text = value instanceof Date ? value.toISOString() : String(value);
  const normalized = normalizeWhitespace(text);
  return normalized || null;
}

function normalizeAuthorHandle(value: string | null | undefined): string | null {
  const normalized = normalizeOptionalText(value)?.replace(/^@+/, "");
  return normalized || null;
}

function formatMetadataList(values: Array<string | null | undefined>): string | null {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const normalized = normalizeOptionalText(value);
    if (!normalized) {
      continue;
    }

    const key = normalized.toLocaleLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(normalized);
  }

  return result.length > 0 ? result.join(", ") : null;
}

function formatPaperAuthor(author: PaperMeta["authors"][number]): string | null {
  const name = normalizeOptionalText(author.name);
  const handle = normalizeAuthorHandle(author.user);

  if (name && handle) {
    return `${name} (@${handle})`;
  }

  return name ?? (handle ? `@${handle}` : null);
}

function formatAuthorSourceLine(input: KnowledgeChunkRetrievalTextInput): string {
  const authorName = normalizeOptionalText(input.authorName) ?? "Unknown";
  const authorHandle = normalizeAuthorHandle(input.authorHandle);

  return authorHandle ? `${authorName} / @${authorHandle}` : authorName;
}

function formatMetric(value: number | null | undefined): string | null {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString("en-US")
    : null;
}

function formatGithubSignal(
  url: string | null | undefined,
  stars: number | null | undefined,
): string | null {
  const normalizedUrl = normalizeOptionalText(url);
  const formattedStars = formatMetric(stars);

  if (normalizedUrl && formattedStars) {
    return `${normalizedUrl} (${formattedStars} stars)`;
  }

  return normalizedUrl ?? (formattedStars ? `${formattedStars} stars` : null);
}

function appendLabeledText(
  lines: string[],
  label: string,
  value: string | null | undefined,
) {
  const normalized = normalizeOptionalText(value);
  if (normalized) {
    lines.push(`${label}: ${normalized}`);
  }
}

function appendLabeledList(
  lines: string[],
  label: string,
  values: Array<string | null | undefined> | null | undefined,
) {
  const formatted = formatMetadataList(values ?? []);
  if (formatted) {
    lines.push(`${label}: ${formatted}`);
  }
}

function appendPaperProviderSignals(lines: string[], paperMeta: PaperMeta) {
  const topLevelGithub = formatGithubSignal(
    paperMeta.githubRepo,
    paperMeta.githubStars,
  );
  const hf = paperMeta.providers?.hf;
  const alphaxiv = paperMeta.providers?.alphaxiv;

  appendLabeledText(lines, "AI summary", paperMeta.aiSummary);
  appendLabeledList(lines, "AI keywords", paperMeta.aiKeywords);
  appendLabeledText(lines, "GitHub signal", topLevelGithub);

  if (hf) {
    appendLabeledText(lines, "HF AI summary", hf.aiSummary);
    appendLabeledList(lines, "HF AI keywords", hf.aiKeywords);
    appendLabeledText(
      lines,
      "HF signal",
      formatMetadataList([
        formatMetric(hf.upvotes) ? `${formatMetric(hf.upvotes)} upvotes` : null,
        formatMetric(hf.numComments)
          ? `${formatMetric(hf.numComments)} comments`
          : null,
      ]),
    );
    appendLabeledText(
      lines,
      "HF GitHub signal",
      formatGithubSignal(hf.githubRepo, hf.githubStars),
    );
  }

  if (alphaxiv) {
    appendLabeledText(lines, "alphaXiv summary", alphaxiv.summary);
    appendLabeledList(lines, "alphaXiv topics", alphaxiv.topics);
    appendLabeledText(
      lines,
      "alphaXiv signal",
      formatMetadataList([
        formatMetric(alphaxiv.votes) ? `${formatMetric(alphaxiv.votes)} votes` : null,
        formatMetric(alphaxiv.visitsAll)
          ? `${formatMetric(alphaxiv.visitsAll)} visits`
          : null,
        formatMetric(alphaxiv.visitsLast7Days)
          ? `${formatMetric(alphaxiv.visitsLast7Days)} visits last 7 days`
          : null,
      ]),
    );
    appendLabeledText(
      lines,
      "alphaXiv GitHub signal",
      formatGithubSignal(alphaxiv.githubUrl, alphaxiv.githubStars),
    );
    appendLabeledList(lines, "Original problem", alphaxiv.originalProblem);
    appendLabeledList(lines, "Solution", alphaxiv.solution);
    appendLabeledList(lines, "Key insights", alphaxiv.keyInsights);
    appendLabeledList(lines, "Results", alphaxiv.results);
  }
}

function buildPaperMemoryCardDocumentText(item: MemoryBackfillFeedItem): string {
  const lines: string[] = [];
  const paperMeta = item.paper_meta;

  appendLabeledText(lines, "Title", item.title);
  appendLabeledText(lines, "Abstract", item.content);

  if (paperMeta) {
    appendLabeledList(
      lines,
      "Paper authors",
      paperMeta.authors.map(formatPaperAuthor),
    );
    appendPaperProviderSignals(lines, paperMeta);
  }

  if (lines.length > 0) {
    appendLabeledText(lines, "Published", normalizeOptionalText(item.published_at));
  }

  return lines.join("\n");
}

export function isPaperGlobalFullTextChunkingEnabled(
  env: { PAPER_MEMORY_INCLUDE_FULL_TEXT_IN_GLOBAL_CHUNKS?: string } =
    process.env as {
      PAPER_MEMORY_INCLUDE_FULL_TEXT_IN_GLOBAL_CHUNKS?: string;
    },
): boolean {
  return env.PAPER_MEMORY_INCLUDE_FULL_TEXT_IN_GLOBAL_CHUNKS === "true";
}

function buildPaperMemoryDocumentText(
  item: MemoryBackfillFeedItem,
  includeFullText = isPaperGlobalFullTextChunkingEnabled(),
): string {
  const lines = [buildPaperMemoryCardDocumentText(item)];

  if (includeFullText) {
    appendLabeledText(lines, "Full text", item.full_text);
  }

  return lines.join("\n");
}

function buildMemorySourceHash(sourceKind: string, text: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ sourceKind, text: normalizeWhitespace(text) }))
    .digest("hex");
}

export function buildKnowledgeMemoryDocument(
  item: MemoryBackfillFeedItem,
): KnowledgeMemoryDocument {
  const includePaperFullText =
    item.source_type === "paper" && isPaperGlobalFullTextChunkingEnabled();
  const sourceKind =
    item.source_type === "paper"
      ? includePaperFullText
        ? "feed_item:paper:v2-full-text"
        : "feed_item:paper:v3-card"
      : `feed_item:${item.source_type}:v1`;
  const text =
    item.source_type === "paper"
      ? normalizeWhitespace(buildPaperMemoryDocumentText(item, includePaperFullText))
      : normalizeWhitespace(item.content);

  return {
    text,
    sourceKind,
    sourceHash: buildMemorySourceHash(sourceKind, text),
  };
}

export function buildKnowledgeChunkRetrievalText(
  input: KnowledgeChunkRetrievalTextInput,
): string {
  const lines: string[] = [`Source type: ${input.sourceType}`];
  const title = normalizeOptionalText(input.title);
  const publishedAt = normalizeOptionalText(input.publishedAt);
  const entityLabels = formatMetadataList(input.entityLabels ?? []);

  if (title) {
    lines.push(`Title: ${title}`);
  }

  lines.push(`Author/source: ${formatAuthorSourceLine(input)}`);

  if (publishedAt) {
    lines.push(`Published: ${publishedAt}`);
  }

  if (input.sourceType === "paper" && input.paperMeta) {
    const paperAuthors = formatMetadataList(
      input.paperMeta.authors.map(formatPaperAuthor),
    );
    const paperKeywords = formatMetadataList(input.paperMeta.aiKeywords ?? []);

    if (paperAuthors) {
      lines.push(`Paper authors: ${paperAuthors}`);
    }

    if (paperKeywords) {
      lines.push(`Paper keywords: ${paperKeywords}`);
    }
  }

  if (entityLabels) {
    lines.push(`Entities: ${entityLabels}`);
  }

  lines.push("Content:", input.text);

  return lines.join("\n");
}

export function selectKnowledgeChunkEmbeddingText({
  retrievalText,
  text,
}: {
  retrievalText?: string | null;
  text: string;
}): string {
  const normalizedRetrievalText = retrievalText?.trim();
  return normalizedRetrievalText || text;
}

function normalizeEntityLabel(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const label = normalizeWhitespace(value)
    .replace(/^@+/, "")
    .toLowerCase();

  if (!label || label.length > 80) {
    return null;
  }

  return label;
}

function collectEntityLabels(item: MemoryBackfillFeedItem): string[] {
  const labels = new Set<string>();
  const addLabel = (value: string | null | undefined) => {
    const label = normalizeEntityLabel(value);
    if (label) {
      labels.add(label);
    }
  };

  addLabel(item.author_name);
  addLabel(item.author_handle);

  if (item.source_type === "paper") {
    for (const keyword of item.paper_meta?.aiKeywords ?? []) {
      addLabel(keyword);
    }
    for (const author of item.paper_meta?.authors ?? []) {
      addLabel(author.name);
      addLabel(author.user);
    }
  }

  return Array.from(labels).slice(0, 16);
}

function estimateTokenCount(text: string): number {
  const wordCount = normalizeWhitespace(text).split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(wordCount * 1.3));
}

export function splitTextIntoMemoryChunks(
  text: string,
  chunkTokenLimit = DEFAULT_CHUNK_TOKEN_LIMIT,
  chunkTokenOverlap = DEFAULT_CHUNK_TOKEN_OVERLAP,
  maxChunks = DEFAULT_MAX_CHUNKS_PER_ITEM,
): string[] {
  const normalized = normalizeWhitespace(text);
  if (!normalized) {
    return [];
  }

  const tokenLimit = clampPositiveInteger(
    chunkTokenLimit,
    DEFAULT_CHUNK_TOKEN_LIMIT,
    2000,
  );
  const overlap = Math.min(
    clampPositiveInteger(chunkTokenOverlap, DEFAULT_CHUNK_TOKEN_OVERLAP, 500),
    tokenLimit - 1,
  );
  const chunkLimit = clampPositiveInteger(
    maxChunks,
    DEFAULT_MAX_CHUNKS_PER_ITEM,
    100,
  );
  const words = normalized.split(/\s+/);

  if (words.length <= tokenLimit) {
    return [normalized];
  }

  const chunks: string[] = [];
  let start = 0;

  while (start < words.length && chunks.length < chunkLimit) {
    const end = Math.min(start + tokenLimit, words.length);
    chunks.push(words.slice(start, end).join(" "));

    if (end >= words.length) {
      break;
    }

    start = Math.max(end - overlap, start + 1);
  }

  return chunks;
}

function parsePaperHeading(line: string): { level: number; title: string } | null {
  const markdown = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
  if (markdown) {
    return {
      level: markdown[1].length,
      title: normalizeWhitespace(markdown[2]),
    };
  }

  const html = line.match(/^\s*<h([1-6])[^>]*>(.*?)<\/h\1>\s*$/i);
  if (html) {
    return {
      level: Number.parseInt(html[1], 10),
      title: normalizeWhitespace(html[2].replace(/<[^>]+>/g, " ")),
    };
  }

  return null;
}

function splitPaperFullTextIntoSections(text: string): PaperSection[] {
  const normalizedLines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd());
  const sections: PaperSection[] = [];
  const headingStack: Array<{ level: number; title: string }> = [];
  let currentPath: string | null = null;
  let currentLines: string[] = [];

  const flush = () => {
    const sectionText = normalizeWhitespace(currentLines.join("\n"));
    if (sectionText) {
      sections.push({ path: currentPath, text: sectionText });
    }
    currentLines = [];
  };

  for (const line of normalizedLines) {
    const heading = parsePaperHeading(line);
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
    currentPath = headingStack.map((entry) => entry.title).join(" > ");
  }

  flush();

  if (sections.length === 0) {
    const normalized = normalizeWhitespace(text);
    return normalized ? [{ path: null, text: normalized }] : [];
  }

  return sections;
}

function buildPaperFullTextChunkTexts(
  item: MemoryBackfillFeedItem,
  options: Pick<
    BackfillKnowledgeChunksOptions,
    "chunkTokenLimit" | "chunkTokenOverlap" | "maxChunksPerItem"
  > = {},
): string[] {
  const maxChunks = clampPositiveInteger(
    options.maxChunksPerItem,
    DEFAULT_MAX_CHUNKS_PER_ITEM,
    100,
  );
  const chunks: string[] = [];
  const cardText = normalizeWhitespace(buildPaperMemoryCardDocumentText(item));

  if (cardText) {
    chunks.push(`Paper card:\n${cardText}`);
  }

  const fullText = item.full_text?.trim();
  if (!fullText || chunks.length >= maxChunks) {
    return chunks;
  }

  for (const section of splitPaperFullTextIntoSections(fullText)) {
    if (chunks.length >= maxChunks) {
      break;
    }

    const remainingChunkCount = maxChunks - chunks.length;
    const sectionChunks = splitTextIntoMemoryChunks(
      section.text,
      options.chunkTokenLimit,
      options.chunkTokenOverlap,
      remainingChunkCount,
    );
    const sectionPath = section.path ?? "Full text";

    for (const sectionChunk of sectionChunks) {
      chunks.push(`Section: ${sectionPath}\n${sectionChunk}`);
      if (chunks.length >= maxChunks) {
        break;
      }
    }
  }

  return chunks;
}

export function buildKnowledgeChunkDrafts(
  item: MemoryBackfillFeedItem,
  options: Pick<
    BackfillKnowledgeChunksOptions,
    "chunkTokenLimit" | "chunkTokenOverlap" | "maxChunksPerItem"
  > = {},
): KnowledgeChunkDraft[] {
  const entityLabels = collectEntityLabels(item);
  const memoryDocument = buildKnowledgeMemoryDocument(item);
  const texts =
    item.source_type === "paper" &&
    isPaperGlobalFullTextChunkingEnabled() &&
    normalizeOptionalText(item.full_text)
      ? buildPaperFullTextChunkTexts(item, options)
      : splitTextIntoMemoryChunks(
          memoryDocument.text,
          options.chunkTokenLimit,
          options.chunkTokenOverlap,
          options.maxChunksPerItem,
        );

  return texts.map((text, index) => {
    const draft = {
      feedItemId: item.id,
      chunkIndex: index,
      sourceType: item.source_type,
      title: item.title,
      authorName: item.author_name,
      authorHandle: item.author_handle,
      publishedAt: item.published_at,
      text,
      tokenCount: estimateTokenCount(text),
      entityLabels,
      memorySourceHash: memoryDocument.sourceHash,
      memorySourceKind: memoryDocument.sourceKind,
    };

    return {
      ...draft,
      retrievalText: buildKnowledgeChunkRetrievalText({
        sourceType: draft.sourceType,
        title: draft.title,
        authorName: draft.authorName,
        authorHandle: draft.authorHandle,
        publishedAt: draft.publishedAt,
        text: draft.text,
        entityLabels: draft.entityLabels,
        paperMeta: item.paper_meta,
      }),
    };
  });
}

export function isMemoryChunkBackfillEnabled(
  env: { MEMORY_CHUNK_BACKFILL_ENABLED?: string } = process.env as {
    MEMORY_CHUNK_BACKFILL_ENABLED?: string;
  },
): boolean {
  return env.MEMORY_CHUNK_BACKFILL_ENABLED?.toLowerCase() === "true";
}

export function isMemoryChunkWritesEnabled(
  env: { MEMORY_CHUNK_WRITES_ENABLED?: string } = process.env as {
    MEMORY_CHUNK_WRITES_ENABLED?: string;
  },
): boolean {
  return env.MEMORY_CHUNK_WRITES_ENABLED === "true";
}

async function selectFeedItemsForBackfill(
  options: Required<
    Pick<BackfillKnowledgeChunksOptions, "limit" | "refreshExisting">
  > &
    Pick<BackfillKnowledgeChunksOptions, "afterId" | "beforeId" | "feedItemId">,
): Promise<MemoryBackfillFeedItem[]> {
  return sql`
    SELECT
      fi.id,
      fi.source_type,
      fi.title,
      fi.content,
      fi.author_name,
      fi.author_handle,
      fi.published_at,
      fi.paper_meta,
      fi.full_text,
      fi.full_text_source
    FROM feed_items fi
    WHERE (${options.feedItemId ?? null}::integer IS NULL OR fi.id = ${options.feedItemId ?? null})
      AND (${options.afterId ?? null}::integer IS NULL OR fi.id > ${options.afterId ?? null})
      AND (${options.beforeId ?? null}::integer IS NULL OR fi.id <= ${options.beforeId ?? null})
      AND (
        ${options.refreshExisting}
        OR NOT EXISTS (
          SELECT 1
          FROM knowledge_chunks kc
          WHERE kc.feed_item_id = fi.id
        )
        OR EXISTS (
          SELECT 1
          FROM knowledge_chunks kc
          WHERE kc.feed_item_id = fi.id
            AND (
              kc.memory_source_hash IS NULL
              OR kc.memory_source_kind IS NULL
            )
        )
      )
    ORDER BY fi.id ASC
    LIMIT ${options.limit}
  ` as Promise<MemoryBackfillFeedItem[]>;
}

async function deleteKnowledgeChunksForFeedItem(feedItemId: number) {
  await sql`
    DELETE FROM knowledge_chunks
    WHERE feed_item_id = ${feedItemId}
  `;
}

async function embedKnowledgeChunkDrafts(
  chunks: KnowledgeChunkDraft[],
): Promise<EmbeddedKnowledgeChunkDraft[]> {
  if (!isMemoryVectorEnabled()) {
    return chunks.map((chunk) => ({
      ...chunk,
      embedding: null,
      embeddingModel: null,
    }));
  }

  const { embeddings, model } = await embedMemoryTexts(
    chunks.map(selectKnowledgeChunkEmbeddingText),
  );
  return chunks.map((chunk, index) => ({
    ...chunk,
    embedding: embeddings[index] ?? null,
    embeddingModel: embeddings[index] ? model : null,
  }));
}

async function upsertKnowledgeChunk(chunk: EmbeddedKnowledgeChunkDraft) {
  if (chunk.embedding && chunk.embeddingModel) {
    const vectorLiteral = formatPgVectorLiteral(chunk.embedding);
    await sql`
      INSERT INTO knowledge_chunks (
        feed_item_id,
        chunk_index,
        source_type,
        title,
        author_name,
        published_at,
        text,
        retrieval_text,
        memory_source_hash,
        memory_source_kind,
        token_count,
        entity_labels,
        embedding,
        embedding_model,
        embedding_updated_at
      ) VALUES (
        ${chunk.feedItemId},
        ${chunk.chunkIndex},
        ${chunk.sourceType},
        ${chunk.title},
        ${chunk.authorName},
        ${chunk.publishedAt},
        ${chunk.text},
        ${chunk.retrievalText},
        ${chunk.memorySourceHash},
        ${chunk.memorySourceKind},
        ${chunk.tokenCount},
        ${chunk.entityLabels},
        ${vectorLiteral}::vector,
        ${chunk.embeddingModel},
        NOW()
      )
      ON CONFLICT (feed_item_id, chunk_index) DO UPDATE
      SET
        source_type = EXCLUDED.source_type,
        title = EXCLUDED.title,
        author_name = EXCLUDED.author_name,
        published_at = EXCLUDED.published_at,
        text = EXCLUDED.text,
        retrieval_text = EXCLUDED.retrieval_text,
        memory_source_hash = EXCLUDED.memory_source_hash,
        memory_source_kind = EXCLUDED.memory_source_kind,
        token_count = EXCLUDED.token_count,
        entity_labels = EXCLUDED.entity_labels,
        embedding = EXCLUDED.embedding,
        embedding_model = EXCLUDED.embedding_model,
        embedding_updated_at = EXCLUDED.embedding_updated_at,
        updated_at = NOW()
    `;
    return;
  }

  await sql`
    INSERT INTO knowledge_chunks (
      feed_item_id,
      chunk_index,
      source_type,
      title,
      author_name,
      published_at,
      text,
      retrieval_text,
      memory_source_hash,
      memory_source_kind,
      token_count,
      entity_labels
    ) VALUES (
      ${chunk.feedItemId},
      ${chunk.chunkIndex},
      ${chunk.sourceType},
      ${chunk.title},
      ${chunk.authorName},
      ${chunk.publishedAt},
      ${chunk.text},
      ${chunk.retrievalText},
      ${chunk.memorySourceHash},
      ${chunk.memorySourceKind},
      ${chunk.tokenCount},
      ${chunk.entityLabels}
    )
    ON CONFLICT (feed_item_id, chunk_index) DO UPDATE
    SET
      source_type = EXCLUDED.source_type,
      title = EXCLUDED.title,
      author_name = EXCLUDED.author_name,
      published_at = EXCLUDED.published_at,
      text = EXCLUDED.text,
      retrieval_text = EXCLUDED.retrieval_text,
      memory_source_hash = EXCLUDED.memory_source_hash,
      memory_source_kind = EXCLUDED.memory_source_kind,
      token_count = EXCLUDED.token_count,
      entity_labels = EXCLUDED.entity_labels,
      embedding = NULL,
      embedding_model = NULL,
      embedding_updated_at = NULL,
      updated_at = NOW()
  `;
}

function toRowCount(value: unknown): number {
  if (typeof value === "number") {
    return value;
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

async function getKnowledgeChunkFreshness(
  item: MemoryBackfillFeedItem,
  options: Pick<
    BackfillKnowledgeChunksOptions,
    "chunkTokenLimit" | "chunkTokenOverlap" | "maxChunksPerItem"
  > = {},
): Promise<{
  isFresh: boolean;
  expectedChunkCount: number;
  existingChunkCount: number;
  staleChunkCount: number;
  memoryDocument: KnowledgeMemoryDocument;
}> {
  const memoryDocument = buildKnowledgeMemoryDocument(item);
  const expectedChunkCount = buildKnowledgeChunkDrafts(item, options).length;
  const rows = (await sql`
    SELECT
      COUNT(*)::integer AS existing_chunk_count,
      COUNT(*) FILTER (
        WHERE memory_source_hash IS DISTINCT FROM ${memoryDocument.sourceHash}
           OR memory_source_kind IS DISTINCT FROM ${memoryDocument.sourceKind}
      )::integer AS stale_chunk_count
    FROM knowledge_chunks
    WHERE feed_item_id = ${item.id}
  `) as Array<{
    existing_chunk_count: number | string;
    stale_chunk_count: number | string;
  }>;
  const row = rows[0];
  const existingChunkCount = toRowCount(row?.existing_chunk_count);
  const staleChunkCount = toRowCount(row?.stale_chunk_count);

  return {
    isFresh:
      existingChunkCount === expectedChunkCount && staleChunkCount === 0,
    expectedChunkCount,
    existingChunkCount,
    staleChunkCount,
    memoryDocument,
  };
}

export async function refreshKnowledgeChunksForFeedItem(
  item: MemoryBackfillFeedItem,
  options: Pick<
    BackfillKnowledgeChunksOptions,
    "chunkTokenLimit" | "chunkTokenOverlap" | "maxChunksPerItem"
  > = {},
): Promise<RefreshKnowledgeChunksForFeedItemResult> {
  const memoryDocument = buildKnowledgeMemoryDocument(item);
  const chunks = buildKnowledgeChunkDrafts(item, options);

  if (chunks.length === 0) {
    await deleteKnowledgeChunksForFeedItem(item.id);
    return {
      upsertedChunkCount: 0,
      skippedItem: true,
      sourceHash: memoryDocument.sourceHash,
      sourceKind: memoryDocument.sourceKind,
    };
  }

  let embeddedChunks: EmbeddedKnowledgeChunkDraft[];
  try {
    embeddedChunks = await embedKnowledgeChunkDrafts(chunks);
  } catch (error) {
    console.error("memory_chunks.embedding_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  await deleteKnowledgeChunksForFeedItem(item.id);

  try {
    for (const chunk of embeddedChunks) {
      await upsertKnowledgeChunk(chunk);
    }
  } catch (error) {
    await deleteKnowledgeChunksForFeedItem(item.id);
    throw error;
  }

  return {
    upsertedChunkCount: chunks.length,
    skippedItem: false,
    sourceHash: memoryDocument.sourceHash,
    sourceKind: memoryDocument.sourceKind,
  };
}

export async function refreshKnowledgeChunksForFeedItemIfStale(
  item: MemoryBackfillFeedItem,
  options: Pick<
    BackfillKnowledgeChunksOptions,
    "chunkTokenLimit" | "chunkTokenOverlap" | "maxChunksPerItem"
  > = {},
): Promise<RefreshKnowledgeChunksForFeedItemIfStaleResult> {
  const freshness = await getKnowledgeChunkFreshness(item, options);

  if (freshness.isFresh) {
    return {
      upsertedChunkCount: 0,
      skippedItem: freshness.expectedChunkCount === 0,
      refreshed: false,
      sourceHash: freshness.memoryDocument.sourceHash,
      sourceKind: freshness.memoryDocument.sourceKind,
    };
  }

  return {
    ...(await refreshKnowledgeChunksForFeedItem(item, options)),
    refreshed: true,
  };
}

export async function writeKnowledgeChunksForFeedItem(
  item: MemoryBackfillFeedItem,
  options: Pick<
    BackfillKnowledgeChunksOptions,
    "chunkTokenLimit" | "chunkTokenOverlap" | "maxChunksPerItem"
  > = {},
): Promise<WriteKnowledgeChunksForFeedItemResult> {
  if (buildKnowledgeChunkDrafts(item, options).length === 0) {
    return {
      upsertedChunkCount: 0,
      skippedItem: true,
    };
  }

  const result = await refreshKnowledgeChunksForFeedItem(item, options);

  return {
    upsertedChunkCount: result.upsertedChunkCount,
    skippedItem: result.skippedItem,
  };
}

export async function backfillKnowledgeChunks(
  options: BackfillKnowledgeChunksOptions = {},
): Promise<BackfillKnowledgeChunksResult> {
  const normalizedOptions = {
    limit: clampPositiveInteger(
      options.limit,
      DEFAULT_BACKFILL_LIMIT,
      MAX_BACKFILL_LIMIT,
    ),
    afterId: options.afterId ?? null,
    beforeId: options.beforeId ?? null,
    feedItemId: options.feedItemId ?? null,
    refreshExisting: options.refreshExisting ?? false,
  };
  const items = await selectFeedItemsForBackfill(normalizedOptions);
  const errors: string[] = [];
  let upsertedChunkCount = 0;
  let skippedItemCount = 0;
  let failedItemCount = 0;

  for (const item of items) {
    try {
      const chunkResult = await refreshKnowledgeChunksForFeedItem(item, options);

      if (chunkResult.skippedItem) {
        skippedItemCount += 1;
        continue;
      }

      upsertedChunkCount += chunkResult.upsertedChunkCount;
    } catch (error) {
      failedItemCount += 1;
      errors.push(
        `feed_item_id=${item.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return {
    selectedItemCount: items.length,
    upsertedChunkCount,
    skippedItemCount,
    failedItemCount,
    lastFeedItemId: items.at(-1)?.id ?? normalizedOptions.afterId,
    errors,
  };
}
