import { sql } from "@/lib/db";
import { isMemoryReadsEnabled } from "@/lib/memory-retrieval";
import { BRIEFING, BRIEFING_MEMORY } from "@/lib/prompts";
import type {
  Digest,
  FeedItem,
  FeedItemSourceType,
  PaperMeta,
  TopReply,
  TweetMeta,
} from "@/lib/schema";

export const CURRENT_BRIEFING_MODEL = "gpt-realtime";
export const DEFAULT_BRIEFING_MODEL = "gpt-realtime-2";

export type BriefingRealtimeModel =
  | typeof DEFAULT_BRIEFING_MODEL
  | typeof CURRENT_BRIEFING_MODEL;

export interface BriefingBudgetProfile {
  baseInstructionsChars: number;
  digestContextChars: number;
  digestItemManifestChars: number;
  sourceIndexChars: number;
  sourceIndexItemCount: number;
  combinedTargetChars: number;
  combinedHardCeilingChars: number;
  toolPayloadTargetChars: number;
  previewChars: Record<FeedItemSourceType, number>;
}

export const CURRENT_REALTIME_BRIEFING_BUDGETS = {
  baseInstructionsChars: 1500,
  digestContextChars: 6000,
  digestItemManifestChars: 2000,
  sourceIndexChars: 4000,
  sourceIndexItemCount: 12,
  combinedTargetChars: 12000,
  combinedHardCeilingChars: 16000,
  toolPayloadTargetChars: 2500,
  previewChars: {
    tweet: 280,
    paper: 240,
    podcast: 240,
    newsletter: 240,
  },
} as const satisfies BriefingBudgetProfile;

export const REALTIME2_BRIEFING_BUDGETS = {
  baseInstructionsChars: 1500,
  digestContextChars: 80000,
  digestItemManifestChars: 40000,
  sourceIndexChars: 200000,
  sourceIndexItemCount: 200,
  combinedTargetChars: 320000,
  combinedHardCeilingChars: 420000,
  toolPayloadTargetChars: 2500,
  previewChars: {
    tweet: 280,
    paper: 240,
    podcast: 240,
    newsletter: 240,
  },
} as const satisfies BriefingBudgetProfile;

export const BRIEFING_BUDGETS = REALTIME2_BRIEFING_BUDGETS;

const BRIEFING_TWEET_CAP = 4;
const DIGEST_COMPACTION_STEPS = [6000, 5200, 4400, 3600, 2800, 2000, 1400] as const;
const PREVIEW_SCALE_STEPS = [1, 0.85, 0.7, 0.55] as const;
const SOURCE_INDEX_HARD_FALLBACKS = [
  { maxItems: 8, maxChars: 2800 },
  { maxItems: 6, maxChars: 2000 },
] as const;
const TOOL_EXCERPT_LIMITS: Record<FeedItemSourceType, number> = {
  tweet: 800,
  paper: 800,
  podcast: 1200,
  newsletter: 1200,
};

export function isBriefingRealtime2Model(
  model: string,
): model is typeof DEFAULT_BRIEFING_MODEL {
  return model === DEFAULT_BRIEFING_MODEL;
}

export function resolveBriefingRealtimeModel(
  env: Record<string, string | undefined> = process.env,
): BriefingRealtimeModel {
  const requestedModel = env.BRIEFING_REALTIME_MODEL?.trim();
  if (
    requestedModel === DEFAULT_BRIEFING_MODEL ||
    requestedModel === CURRENT_BRIEFING_MODEL
  ) {
    return requestedModel as BriefingRealtimeModel;
  }

  return DEFAULT_BRIEFING_MODEL;
}

export function briefingBudgetsForModel(
  model: string = DEFAULT_BRIEFING_MODEL,
): BriefingBudgetProfile {
  return model === CURRENT_BRIEFING_MODEL
    ? CURRENT_REALTIME_BRIEFING_BUDGETS
    : REALTIME2_BRIEFING_BUDGETS;
}

export type BriefingBudgetFallbackStep =
  | "shorten_previews"
  | "drop_index_items"
  | "compact_manifest_labels"
  | "compact_digest_context";

export interface BriefingSourceItem {
  id: number;
  source_type: FeedItemSourceType;
  title: string | null;
  author_name: string;
  published_at: string | null;
  url: string;
  preview: string;
  retrievalRank: number;
}

export interface BriefingDigestItemManifestItem {
  id: number;
  source_type: FeedItemSourceType;
  label: string;
}

export interface BriefingSourceIndexItem {
  id: number;
  source_type: FeedItemSourceType;
  title: string | null;
  author_name: string;
  published_at: string | null;
  url: string;
  preview: string;
}

export interface BriefingDigestContextBlock {
  text: string;
  charCount: number;
  maxChars: number;
}

export interface BriefingDigestItemManifest {
  items: BriefingDigestItemManifestItem[];
  text: string;
  charCount: number;
  compactLabels: boolean;
}

export interface BriefingSourceIndex {
  items: BriefingSourceIndexItem[];
  text: string;
  charCount: number;
  previewCharLimits: Record<FeedItemSourceType, number>;
  stepsApplied: BriefingBudgetFallbackStep[];
}

export interface BriefingPromptBudget {
  baseInstructionsChars: number;
  digestContextChars: number;
  digestItemManifestChars: number;
  sourceIndexChars: number;
  sourceIndexItemCount: number;
  toolSchemasChars: number;
  instructionsChars: number;
  combinedChars: number;
  withinTargets: {
    baseInstructions: boolean;
    digestContext: boolean;
    digestItemManifest: boolean;
    sourceIndex: boolean;
    sourceIndexItemCount: boolean;
    combined: boolean;
  };
  withinHardCeiling: boolean;
}

export interface BriefingPromptPayload {
  baseInstructions: string;
  digestContext: BriefingDigestContextBlock;
  digestItemManifest: BriefingDigestItemManifest;
  sourceIndex: BriefingSourceIndex;
  instructions: string;
  tools: BriefingToolDefinition[];
  budget: BriefingPromptBudget;
  rankedSourceItems: BriefingSourceItem[];
  stepsApplied: BriefingBudgetFallbackStep[];
}

export interface BriefingToolDefinition {
  type: "function";
  name:
    | "get_digest_item"
    | "search_archive"
    | "list_archive_items"
    | "search_memory"
    | "get_memory_item"
    | "wait_for_user";
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: false;
  };
}

export interface FormattedDigestItemToolResult {
  id: number;
  source_type: FeedItemSourceType;
  title: string | null;
  author_name: string;
  url: string;
  published_at: string | null;
  content_excerpt: string;
  tweet_meta: TweetMeta | null;
  paper_meta: PaperMeta | null;
}

export interface BriefingPromptTokenCountRepresentation {
  model: string;
  input: Array<{
    role: "system";
    content: Array<{
      type: "input_text";
      text: string;
    }>;
  }>;
  tools: BriefingToolDefinition[];
}

export type BriefingPromptTokenEstimate =
  | {
      available: true;
      inputTokens: number;
      response: unknown;
    }
  | {
      available: false;
      reason:
        | "missing_api_key"
        | "missing_fetch"
        | "timeout"
        | "request_failed"
        | "invalid_response"
        | `http_${number}`;
      status?: number;
      response?: unknown;
      error?: string;
    };

interface BriefingSourceQueryRow {
  id: number;
  source_type: FeedItemSourceType;
  title: string | null;
  author_name: string;
  published_at: string | null;
  url: string;
  preview: string | null;
}

interface RankedBriefingSourceItem extends BriefingSourceItem {
  titleMentionBoost: number;
  authorMentionBoost: number;
  hasTitle: number;
  richnessScore: number;
  publishedAtValue: number;
}

function normalizeMarkdown(value: string): string {
  const normalized = value
    .replace(/\r\n?/g, "\n")
    .replace(/\t+/g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \f\v]+/g, " ").trim())
    .filter((line) => !/^[-*_]{3,}$/.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return normalized;
}

function normalizeInline(value: string): string {
  return normalizeMarkdown(
    value
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
      .replace(/[`*_>#]/g, " ")
      .replace(/\s+/g, " "),
  )
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateAtBoundary(value: string, maxChars: number): string {
  const normalized = value.trim();
  if (maxChars <= 0) {
    return "";
  }
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
  const trimmed = (boundary > allowance * 0.5 ? slice.slice(0, boundary) : slice).trim();
  return `${trimmed || slice.trim()}...`;
}

function truncateMarkdownBlock(value: string, maxChars: number): string {
  const normalized = normalizeMarkdown(value);
  if (normalized.length <= maxChars) {
    return normalized;
  }

  const lines = normalized.split("\n");
  let result = "";

  for (const line of lines) {
    const next = result ? `${result}\n${line}` : line;
    if (next.length <= maxChars) {
      result = next;
      continue;
    }

    const remaining = maxChars - (result ? result.length + 1 : 0);
    if (remaining > 0) {
      const truncatedLine = truncateAtBoundary(line, remaining);
      result = result ? `${result}\n${truncatedLine}` : truncatedLine;
    }
    break;
  }

  return result.trim();
}

function renderSection(title: string, body: string, maxChars?: number): string {
  const sectionPrefix = `## ${title}\n`;
  const normalizedBody = normalizeMarkdown(body) || "Unavailable.";

  if (maxChars === undefined) {
    return `${sectionPrefix}${normalizedBody}`;
  }

  const allowance = Math.max(maxChars - sectionPrefix.length, 0);
  const boundedBody = truncateMarkdownBlock(normalizedBody, allowance);
  const section = `${sectionPrefix}${boundedBody}`;

  if (section.length <= maxChars) {
    return section;
  }

  return truncateAtBoundary(section, maxChars);
}

function previewLimitFor(
  sourceType: FeedItemSourceType,
  scale = 1,
  budgets: BriefingBudgetProfile = BRIEFING_BUDGETS,
): number {
  const base = budgets.previewChars[sourceType];
  return Math.max(Math.floor(base * scale), 80);
}

function normalizeSourceRows(
  rows: BriefingSourceQueryRow[],
  retrievalOrder?: number[],
): BriefingSourceItem[] {
  const orderMap = new Map<number, number>();

  if (retrievalOrder) {
    retrievalOrder.forEach((id, index) => orderMap.set(id, index));
  }

  const deduped = new Map<number, BriefingSourceItem>();
  const orderedRows = [...rows].sort((left, right) => {
    if (!retrievalOrder) {
      return left.id - right.id;
    }

    return (orderMap.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
      (orderMap.get(right.id) ?? Number.MAX_SAFE_INTEGER);
  });

  orderedRows.forEach((row, index) => {
    if (deduped.has(row.id)) {
      return;
    }

    const preview = normalizeInline(
      row.preview ?? row.title ?? row.author_name,
    );

    deduped.set(row.id, {
      id: row.id,
      source_type: row.source_type,
      title: row.title,
      author_name: row.author_name,
      published_at: row.published_at,
      url: row.url,
      preview,
      retrievalRank: retrievalOrder
        ? (orderMap.get(row.id) ?? index)
        : index,
    });
  });

  return Array.from(deduped.values());
}

function textMatchBoost(haystack: string, needle: string | null): number {
  if (!needle) {
    return 0;
  }

  const normalizedNeedle = normalizeInline(needle).toLowerCase();
  if (normalizedNeedle.length < 4) {
    return 0;
  }

  return haystack.includes(normalizedNeedle) ? 1 : 0;
}

function authorMatchBoost(haystack: string, authorName: string): number {
  const normalized = normalizeInline(authorName).toLowerCase();
  if (!normalized) {
    return 0;
  }

  const parts = normalized.split(" ").filter(Boolean);
  const candidates = new Set<string>([normalized]);

  if (parts.length > 1) {
    const first = parts[0];
    const last = parts[parts.length - 1];
    if (first.length >= 5) {
      candidates.add(first);
    }
    if (last.length >= 5) {
      candidates.add(last);
    }
  }

  for (const candidate of candidates) {
    if (haystack.includes(candidate)) {
      return 1;
    }
  }

  return 0;
}

function richnessScoreFor(item: BriefingSourceItem): number {
  const sourceTypeBoost =
    item.source_type === "tweet"
      ? 1
      : item.source_type === "paper"
        ? 4
        : 3;

  const previewBoost = Math.min(item.preview.length, 240) / 240;
  return sourceTypeBoost + previewBoost;
}

function buildManifestLabel(
  item: BriefingSourceItem,
  compactLabels: boolean,
): string {
  const title = item.title ? normalizeInline(item.title) : null;
  const author = normalizeInline(item.author_name);
  const typeLabel = item.source_type;

  if (compactLabels) {
    if (title) {
      return truncateAtBoundary(title, 42);
    }
    return truncateAtBoundary(`${author} ${typeLabel}`, 28);
  }

  if (title) {
    return truncateAtBoundary(`${title} (${author})`, 88);
  }

  return truncateAtBoundary(`${author} ${typeLabel}`, 52);
}

function buildDisplayLabel(item: BriefingSourceItem): string {
  const title = item.title ? normalizeInline(item.title) : null;
  const author = normalizeInline(item.author_name);

  if (title) {
    return truncateAtBoundary(`${title} (${author})`, 96);
  }

  return truncateAtBoundary(`${author} ${item.source_type}`, 60);
}

function buildPublishedLabel(publishedAt: string | null): string | null {
  if (!publishedAt) {
    return null;
  }

  const str = typeof publishedAt === "string" ? publishedAt : String(publishedAt);
  return str.slice(0, 10);
}

function renderManifestText(items: BriefingDigestItemManifestItem[]): string {
  const lines = items.map(
    (item) => `- [${item.id}] ${item.source_type} | ${item.label}`,
  );
  return renderSection("Digest Item Manifest", lines.join("\n"));
}

function renderSourceIndexText(
  items: BriefingSourceIndexItem[],
): string {
  const lines = items.map((item) => {
    const parts = [
      `[${item.id}] ${item.source_type}`,
      buildDisplayLabel({
        ...item,
        preview: item.preview,
        retrievalRank: 0,
      }),
    ];
    const publishedLabel = buildPublishedLabel(item.published_at);
    if (publishedLabel) {
      parts.push(publishedLabel);
    }
    parts.push(item.preview);
    return `- ${parts.join(" | ")}`;
  });

  return renderSection("Source Index", lines.join("\n"));
}

function selectSourceIndexItems(
  sourceItems: BriefingSourceItem[],
  maxItems: number,
): { selected: BriefingSourceItem[]; mandatoryIds: Set<number> } {
  const selected: BriefingSourceItem[] = [];
  const selectedIds = new Set<number>();
  const mandatoryIds = new Set<number>();
  const sourceTypesInRankOrder = Array.from(
    new Set(sourceItems.map((item) => item.source_type)),
  );
  const effectiveTweetCap =
    sourceTypesInRankOrder.length > 1 ? BRIEFING_TWEET_CAP : maxItems;
  let tweetCount = 0;

  for (const sourceType of sourceTypesInRankOrder) {
    const candidate = sourceItems.find((item) => item.source_type === sourceType);
    if (!candidate || selected.length >= maxItems) {
      continue;
    }

    selected.push(candidate);
    selectedIds.add(candidate.id);
    mandatoryIds.add(candidate.id);
    if (candidate.source_type === "tweet") {
      tweetCount += 1;
    }
  }

  for (const item of sourceItems) {
    if (selected.length >= maxItems || selectedIds.has(item.id)) {
      continue;
    }
    if (item.source_type === "tweet" && tweetCount >= effectiveTweetCap) {
      continue;
    }

    selected.push(item);
    selectedIds.add(item.id);
    if (item.source_type === "tweet") {
      tweetCount += 1;
    }
  }

  return { selected, mandatoryIds };
}

function buildSourceIndexItems(
  sourceItems: BriefingSourceItem[],
  previewLimits: Record<FeedItemSourceType, number>,
): BriefingSourceIndexItem[] {
  return sourceItems.map((item) => ({
    id: item.id,
    source_type: item.source_type,
    title: item.title,
    author_name: item.author_name,
    published_at: item.published_at,
    url: item.url,
    preview: truncateAtBoundary(
      normalizeInline(item.preview || item.title || item.author_name),
      previewLimits[item.source_type],
    ),
  }));
}

function trimSourceIndexItems(
  items: BriefingSourceIndexItem[],
  mandatoryIds: Set<number>,
  maxChars: number,
): BriefingSourceIndexItem[] {
  const next = [...items];

  while (next.length > 1 && renderSourceIndexText(next).length > maxChars) {
    const removableIndex = (() => {
      for (let index = next.length - 1; index >= 0; index -= 1) {
        if (!mandatoryIds.has(next[index].id)) {
          return index;
        }
      }
      return next.length - 1;
    })();

    next.splice(removableIndex, 1);
  }

  return next;
}

function buildSourceIndexWithBudget(
  sourceItems: BriefingSourceItem[],
  maxChars: number,
  maxItems: number,
  budgets: BriefingBudgetProfile = BRIEFING_BUDGETS,
): BriefingSourceIndex {
  const stepsApplied: BriefingBudgetFallbackStep[] = [];
  const { selected, mandatoryIds } = selectSourceIndexItems(sourceItems, maxItems);
  let chosenScale: number = PREVIEW_SCALE_STEPS[0];
  let indexItems = buildSourceIndexItems(
    selected,
    buildPreviewLimits(chosenScale, budgets),
  );
  let text = renderSourceIndexText(indexItems);

  if (text.length > maxChars) {
    for (const scale of PREVIEW_SCALE_STEPS.slice(1)) {
      const candidateItems = buildSourceIndexItems(
        selected,
        buildPreviewLimits(scale, budgets),
      );
      const candidateText = renderSourceIndexText(candidateItems);
      if (candidateText.length <= text.length) {
        chosenScale = scale;
        indexItems = candidateItems;
        text = candidateText;
      }
      if (candidateText.length <= maxChars) {
        stepsApplied.push("shorten_previews");
        break;
      }
    }
  }

  if (text.length > maxChars) {
    const trimmedItems = trimSourceIndexItems(indexItems, mandatoryIds, maxChars);
    if (trimmedItems.length !== indexItems.length) {
      stepsApplied.push("drop_index_items");
      indexItems = trimmedItems;
      text = renderSourceIndexText(indexItems);
    }
  }

  if (text.length > maxChars && !stepsApplied.includes("shorten_previews")) {
    stepsApplied.push("shorten_previews");
  }

  return {
    items: indexItems,
    text,
    charCount: text.length,
    previewCharLimits: buildPreviewLimits(chosenScale, budgets),
    stepsApplied,
  };
}

function buildPreviewLimits(
  scale: number,
  budgets: BriefingBudgetProfile = BRIEFING_BUDGETS,
): Record<FeedItemSourceType, number> {
  return {
    tweet: previewLimitFor("tweet", scale, budgets),
    paper: previewLimitFor("paper", scale, budgets),
    podcast: previewLimitFor("podcast", scale, budgets),
    newsletter: previewLimitFor("newsletter", scale, budgets),
  };
}

function digestCompactionStepsForBudget(
  budgets: BriefingBudgetProfile,
): number[] {
  if (budgets === CURRENT_REALTIME_BRIEFING_BUDGETS) {
    return [...DIGEST_COMPACTION_STEPS];
  }

  const scaledSteps = [1, 0.85, 0.7, 0.55, 0.4, 0.25].map((scale) =>
    Math.floor(budgets.digestContextChars * scale),
  );
  return Array.from(new Set([...scaledSteps, ...DIGEST_COMPACTION_STEPS]))
    .filter((maxChars) => maxChars > 0)
    .sort((left, right) => right - left);
}

function compactDigestContext(
  digest: Pick<Digest, "content">,
  maxChars: number,
): BriefingDigestContextBlock {
  const normalized = normalizeMarkdown(digest.content);
  const text = renderSection("Digest Context", normalized, maxChars);
  return {
    text,
    charCount: text.length,
    maxChars,
  };
}

function serializeToolSchemas(tools: BriefingToolDefinition[]): string {
  return JSON.stringify(tools);
}

function extractInputTokens(value: unknown): number | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const direct = (value as { input_tokens?: unknown }).input_tokens;
  if (typeof direct === "number") {
    return direct;
  }

  const total = (value as { total_tokens?: unknown }).total_tokens;
  if (typeof total === "number") {
    return total;
  }

  const usage = (value as { usage?: { input_tokens?: unknown } }).usage;
  if (usage && typeof usage.input_tokens === "number") {
    return usage.input_tokens;
  }

  return null;
}

function cloneTopReplies(topReplies: TopReply[] | null): TopReply[] | null {
  if (!topReplies) {
    return null;
  }

  return topReplies.slice(0, 3).map((reply) => ({
    authorHandle: truncateAtBoundary(normalizeInline(reply.authorHandle), 40),
    authorName: truncateAtBoundary(normalizeInline(reply.authorName), 60),
    text: truncateAtBoundary(normalizeInline(reply.text), 180),
    likes: reply.likes,
  }));
}

function clonePaperMeta(paperMeta: PaperMeta | null): PaperMeta | null {
  if (!paperMeta) {
    return null;
  }

  return {
    upvotes: paperMeta.upvotes,
    numComments: paperMeta.numComments,
    githubRepo: paperMeta.githubRepo,
    githubStars: paperMeta.githubStars,
    aiSummary: paperMeta.aiSummary
      ? truncateAtBoundary(normalizeInline(paperMeta.aiSummary), 400)
      : null,
    aiKeywords: paperMeta.aiKeywords
      ? paperMeta.aiKeywords
          .slice(0, 8)
          .map((keyword) => truncateAtBoundary(normalizeInline(keyword), 40))
      : null,
    authors: paperMeta.authors.slice(0, 8).map((author) => ({
      name: truncateAtBoundary(normalizeInline(author.name), 80),
      ...(author.user
        ? { user: truncateAtBoundary(normalizeInline(author.user), 40) }
        : {}),
    })),
  };
}

function compactToolPayload(
  item: FormattedDigestItemToolResult,
  budgets: BriefingBudgetProfile = BRIEFING_BUDGETS,
): FormattedDigestItemToolResult {
  let next = {
    ...item,
    tweet_meta: item.tweet_meta
      ? {
          ...item.tweet_meta,
          topReplies: cloneTopReplies(item.tweet_meta.topReplies),
        }
      : null,
    paper_meta: clonePaperMeta(item.paper_meta),
  };

  if (JSON.stringify(next).length <= budgets.toolPayloadTargetChars) {
    return next;
  }

  if (next.tweet_meta?.topReplies) {
    next = {
      ...next,
      tweet_meta: {
        ...next.tweet_meta,
        topReplies: next.tweet_meta.topReplies.slice(0, 1),
      },
    };
  }

  if (JSON.stringify(next).length <= budgets.toolPayloadTargetChars) {
    return next;
  }

  if (next.paper_meta?.aiSummary) {
    next = {
      ...next,
      paper_meta: {
        ...next.paper_meta,
        aiSummary: truncateAtBoundary(next.paper_meta.aiSummary, 220),
      },
    };
  }

  if (JSON.stringify(next).length <= budgets.toolPayloadTargetChars) {
    return next;
  }

  next = {
    ...next,
    content_excerpt: truncateAtBoundary(
      next.content_excerpt,
      Math.max(Math.floor(next.content_excerpt.length * 0.7), 240),
    ),
    tweet_meta: next.tweet_meta
      ? {
          ...next.tweet_meta,
          topReplies: null,
        }
      : null,
    paper_meta: next.paper_meta
      ? {
          ...next.paper_meta,
          aiSummary: next.paper_meta.aiSummary
            ? truncateAtBoundary(next.paper_meta.aiSummary, 140)
            : null,
          aiKeywords: next.paper_meta.aiKeywords?.slice(0, 5) ?? null,
          authors: next.paper_meta.authors.slice(0, 5),
        }
      : null,
  };

  return next;
}

export async function getBriefingSourceItems({
  digest,
  generatedAt,
}: {
  digest: Pick<Digest, "source_item_ids" | "generated_at">;
  generatedAt?: string;
}): Promise<BriefingSourceItem[]> {
  const effectiveGeneratedAt = generatedAt ?? digest.generated_at;
  const sourceItemIds = digest.source_item_ids ?? [];

  if (sourceItemIds.length > 0) {
    const rows = (await sql`
      SELECT
        id,
        source_type,
        title,
        author_name,
        published_at,
        url,
        CASE
          WHEN source_type = 'paper' THEN LEFT(COALESCE(paper_meta->>'aiSummary', content), 900)
          WHEN source_type = 'tweet' THEN LEFT(content, 560)
          ELSE LEFT(content, 900)
        END AS preview
      FROM feed_items
      WHERE id = ANY(${sourceItemIds})
    `) as BriefingSourceQueryRow[];

    return normalizeSourceRows(rows, sourceItemIds);
  }

  const recentShort = (await sql`
    SELECT
      id,
      source_type,
      title,
      author_name,
      published_at,
      url,
      CASE
        WHEN source_type = 'paper' THEN LEFT(COALESCE(paper_meta->>'aiSummary', content), 900)
        ELSE LEFT(content, 560)
      END AS preview
    FROM feed_items
    WHERE source_type IN ('tweet', 'paper')
      AND fetched_at > ${effectiveGeneratedAt}::timestamptz - INTERVAL '24 hours'
      AND fetched_at <= ${effectiveGeneratedAt}::timestamptz
    ORDER BY source_type, published_at DESC, id ASC
  `) as BriefingSourceQueryRow[];

  const recentLong = (await sql`
    SELECT
      id,
      source_type,
      title,
      author_name,
      published_at,
      url,
      LEFT(content, 900) AS preview
    FROM feed_items
    WHERE source_type IN ('podcast', 'newsletter')
      AND fetched_at > ${effectiveGeneratedAt}::timestamptz - INTERVAL '72 hours'
      AND fetched_at <= ${effectiveGeneratedAt}::timestamptz
    ORDER BY source_type, published_at DESC, id ASC
  `) as BriefingSourceQueryRow[];

  return normalizeSourceRows([...recentShort, ...recentLong]);
}

export function rankBriefingSourceItems({
  digest,
  sourceItems,
}: {
  digest: Pick<Digest, "content" | "source_item_ids">;
  sourceItems: BriefingSourceItem[];
}): BriefingSourceItem[] {
  const digestText = normalizeInline(digest.content).toLowerCase();
  const ranked = sourceItems.map((item) => {
    const titleMentionBoost = textMatchBoost(digestText, item.title);
    const authorMentionBoost = authorMatchBoost(digestText, item.author_name);

    return {
      ...item,
      titleMentionBoost,
      authorMentionBoost,
      hasTitle: item.title ? 1 : 0,
      richnessScore: richnessScoreFor(item),
      publishedAtValue: item.published_at ? Date.parse(item.published_at) || 0 : 0,
    } satisfies RankedBriefingSourceItem;
  });

  ranked.sort((left, right) => {
    if (right.titleMentionBoost !== left.titleMentionBoost) {
      return right.titleMentionBoost - left.titleMentionBoost;
    }
    if (right.authorMentionBoost !== left.authorMentionBoost) {
      return right.authorMentionBoost - left.authorMentionBoost;
    }
    if (right.hasTitle !== left.hasTitle) {
      return right.hasTitle - left.hasTitle;
    }
    if (right.richnessScore !== left.richnessScore) {
      return right.richnessScore - left.richnessScore;
    }
    if (right.publishedAtValue !== left.publishedAtValue) {
      return right.publishedAtValue - left.publishedAtValue;
    }
    if (left.retrievalRank !== right.retrievalRank) {
      return left.retrievalRank - right.retrievalRank;
    }
    return left.id - right.id;
  });

  return ranked.map((item) => ({
    id: item.id,
    source_type: item.source_type,
    title: item.title,
    author_name: item.author_name,
    published_at: item.published_at,
    url: item.url,
    preview: item.preview,
    retrievalRank: item.retrievalRank,
  }));
}

export function buildBriefingDigestContext(
  digest: Pick<Digest, "content">,
  options: { maxChars?: number; budgets?: BriefingBudgetProfile } = {},
): BriefingDigestContextBlock {
  const budgets = options.budgets ?? BRIEFING_BUDGETS;
  const maxChars = options.maxChars ?? budgets.digestContextChars;
  return compactDigestContext(digest, maxChars);
}

export function buildBriefingDigestItemManifest(
  sourceItems: BriefingSourceItem[],
  options: { compactLabels?: boolean } = {},
): BriefingDigestItemManifest {
  const compactLabels = options.compactLabels ?? false;
  const items = [...sourceItems]
    .sort((left, right) => {
      if (left.retrievalRank !== right.retrievalRank) {
        return left.retrievalRank - right.retrievalRank;
      }
      return left.id - right.id;
    })
    .map((item) => ({
      id: item.id,
      source_type: item.source_type,
      label: buildManifestLabel(item, compactLabels),
    }));

  const text = renderManifestText(items);
  return {
    items,
    text,
    charCount: text.length,
    compactLabels,
  };
}

export function buildBriefingSourceIndex(
  sourceItems: BriefingSourceItem[],
  options: {
    maxItems?: number;
    maxChars?: number;
    budgets?: BriefingBudgetProfile;
  } = {},
): BriefingSourceIndex {
  const budgets = options.budgets ?? BRIEFING_BUDGETS;
  return buildSourceIndexWithBudget(
    sourceItems,
    options.maxChars ?? budgets.sourceIndexChars,
    options.maxItems ?? budgets.sourceIndexItemCount,
    budgets,
  );
}

export function buildBriefingInstructions({
  baseInstructions = BRIEFING,
  digestContext,
  digestItemManifest,
  sourceIndex,
}: {
  baseInstructions?: string;
  digestContext: string;
  digestItemManifest: string;
  sourceIndex: string;
}): string {
  return [
    normalizeMarkdown(baseInstructions),
    normalizeMarkdown(digestContext),
    normalizeMarkdown(digestItemManifest),
    normalizeMarkdown(sourceIndex),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function composeBriefingBaseInstructions({
  baseInstructions = BRIEFING,
  tools,
}: {
  baseInstructions?: string;
  tools: BriefingToolDefinition[];
}): string {
  const hasMemoryTools =
    tools.some((tool) => tool.name === "search_memory") &&
    tools.some((tool) => tool.name === "get_memory_item");

  return [
    normalizeMarkdown(baseInstructions),
    hasMemoryTools ? normalizeMarkdown(BRIEFING_MEMORY) : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function buildBriefingTools({
  env = process.env as { MEMORY_READS_ENABLED?: string },
}: {
  env?: { MEMORY_READS_ENABLED?: string };
} = {}): BriefingToolDefinition[] {
  const tools: BriefingToolDefinition[] = [
    {
      type: "function",
      name: "get_digest_item",
      description:
        "Fetch full detail for one named/visible item in TODAY'S digest by item_id. Use for first/second/next paper, tweet, podcast, newsletter, or item in today's digest. Do not use this as the evidence path for paper methods, results, contributions, benchmarks, datasets, or exact wording; use search_memory with source='paper' and mode='evidence' for those when available. For broad source/corpus questions, use search_memory instead of today's digest unless the user explicitly means today.",
      parameters: {
        type: "object",
        properties: {
          item_id: { type: "integer" },
        },
        required: ["item_id"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "search_archive",
      description:
        "Historical feed-item title/metadata lookup. Use for specific named item/entity lookup, including requests like 'search the archive for PERSON/ENTITY', or one final fallback after two empty search_memory attempts. Do not use for broad semantic content questions when search_memory is available. For exact-title lookups, copy a known source from the source index; podcast/episode titles require source='podcast'. Prefer list_archive_items only for exact author/date/source listing.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          source: {
            type: "string",
            enum: ["all", "tweet", "podcast", "newsletter", "paper"],
          },
          after: { type: "string" },
          before: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 20 },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "list_archive_items",
      description:
        "Structured SQL-style listing across all historical feed items. Use when the user asks for all/recent posts by exact author, source, or date range. Do not use for named-person/entity archive search such as 'search the archive for PERSON/ENTITY'; use search_archive for that. Date filters are inclusive calendar dates; for a whole month, set before to the last day of that month, not the first day of the next month. Supports exact filters and returns total_count plus has_more.",
      parameters: {
        type: "object",
        properties: {
          source: {
            type: "string",
            enum: ["all", "tweet", "podcast", "newsletter", "paper"],
          },
          author: { type: "string" },
          after: { type: "string" },
          before: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 20 },
          offset: { type: "integer", minimum: 0 },
        },
        required: [],
        additionalProperties: false,
      },
    },
  ];

  if (!isMemoryReadsEnabled(env)) {
    return [
      ...tools,
      {
        type: "function",
        name: "wait_for_user",
        description:
          "Client-side no-op for silence/background audio, hold music, TV/audio bleed, nearby speech not addressed to the assistant, or idle backchannels when there is no active briefing to resume. Use when you need to wait without spending retrieval budget.",
        parameters: {
          type: "object",
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
    ];
  }

  return [
    ...tools,
    {
      type: "function",
      name: "search_memory",
      description:
        "Default for semantic content lookup. In briefing voice sessions, currentDigestOnly defaults to true: first search today's digest/source items, then if current_digest_search.status='miss', briefly say today's digest does not support the answer and call search_memory again with currentDigestOnly=false for the broader archive. Search passage results before answering; do not rely on today's digest summary or assumed absence. After results return, answer directly and do not narrate tool success, say the search completed, say information was found, or mention evidence chunks/tool mechanics unless asked. `query` must be content tokens, never meta-words like 'yesterday' or 'digest'. Set `source` for paper/podcast/newsletter/tweet filters. For paper searches, use paperCorpusScope='latest' for what's new, 'default' for normal paper discussion, and 'archive' only for explicit broad prior-work/history searches. For broad paper walkthroughs, summaries, or key-claim requests about a current-digest paper, keep the first evidence query broad: paper title plus terms like 'main claims contributions methods results'. Do not add specific benchmarks, datasets, numbers, author names, or speculative mechanism details unless the user said them or a prior tool result supplied them. For broad paper discovery such as what do we have about X or find papers about X, set source='paper' and mode='discovery'. Discovery results are candidate or related papers from the indexed corpus, not verified answers; phrase naturally as candidate matches and do not phrase as 'the answer is', 'paper X showed that', 'according to', or 'I completed the search and found'. Use mode='evidence' with source='paper' as the first search for scientific/detail claims such as what a paper said, claimed, showed, measured, benchmarked, methods, results, tables, metrics, protocols, or dosages; when unsure, prefer evidence; do not run a separate discovery search first. If paper_evidence.status is not 'supports' or evidence-mode results are empty, say the indexed material did not support the claim without naming chunks or tool internals. Date filters are inclusive calendar dates. For high-stakes medical/legal/dosage claims, do exactly one source-appropriate memory search, then say unsupported if empty; do not retry, broaden, or use archive fallback. For non-high-stakes have-we-covered/seen/mentions questions, retry once with rewritten content tokens after the first empty result.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          scope: {
            type: "string",
            enum: ["all", "chunk"],
          },
          source: {
            type: "string",
            enum: ["all", "tweet", "podcast", "newsletter", "paper"],
          },
          paperCorpusScope: {
            type: "string",
            enum: ["default", "latest", "archive", "all"],
          },
          mode: {
            type: "string",
            enum: ["discovery", "evidence"],
          },
          currentDigestOnly: {
            type: "boolean",
          },
          after: { type: "string" },
          before: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 20 },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "get_memory_item",
      description:
        "Fetch full passage for a memory_id from search_memory. Only when the snippet is insufficient, or the user asks for exact wording, an exact quote, or a full passage. Do not call after a sufficient search_memory snippet for normal have-we-covered/what-did-we-cover questions. Requires prior search_memory call.",
      parameters: {
        type: "object",
        properties: {
          memory_kind: {
            type: "string",
            enum: ["chunk"],
          },
          memory_id: { type: "integer" },
        },
        required: ["memory_kind", "memory_id"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "wait_for_user",
      description:
        "Client-side no-op for silence/background audio, hold music, TV/audio bleed, nearby speech not addressed to the assistant, or idle backchannels when there is no active briefing to resume. Use when you need to wait without spending retrieval budget.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  ];
}

export function formatDigestItemToolResult(
  item: FeedItem,
): FormattedDigestItemToolResult {
  const base: FormattedDigestItemToolResult = {
    id: item.id,
    source_type: item.source_type,
    title: item.title,
    author_name: item.author_name,
    url: item.url,
    published_at: item.published_at,
    content_excerpt: truncateAtBoundary(
      normalizeInline(item.content),
      TOOL_EXCERPT_LIMITS[item.source_type],
    ),
    tweet_meta: item.tweet_meta
      ? {
          likes: item.tweet_meta.likes,
          retweets: item.tweet_meta.retweets,
          replies: item.tweet_meta.replies,
          isQuote: item.tweet_meta.isQuote,
          quotedTweetId: item.tweet_meta.quotedTweetId,
          topReplies: cloneTopReplies(item.tweet_meta.topReplies),
        }
      : null,
    paper_meta: clonePaperMeta(item.paper_meta),
  };

  return compactToolPayload(base);
}

export function estimatePromptBudget({
  baseInstructions = BRIEFING,
  digestContext,
  digestItemManifest,
  sourceIndex,
  tools = buildBriefingTools(),
  sourceIndexItemCount,
  budgets = BRIEFING_BUDGETS,
}: {
  baseInstructions?: string;
  digestContext: string;
  digestItemManifest: string;
  sourceIndex: string;
  tools?: BriefingToolDefinition[];
  sourceIndexItemCount?: number;
  budgets?: BriefingBudgetProfile;
}): BriefingPromptBudget {
  const instructions = buildBriefingInstructions({
    baseInstructions,
    digestContext,
    digestItemManifest,
    sourceIndex,
  });
  const toolSchemasChars = serializeToolSchemas(tools).length;
  const combinedChars = instructions.length + toolSchemasChars;
  const indexItemCount =
    sourceIndexItemCount ??
    sourceIndex
      .split("\n")
      .filter((line) => line.startsWith("- "))
      .length;

  return {
    baseInstructionsChars: normalizeMarkdown(baseInstructions).length,
    digestContextChars: normalizeMarkdown(digestContext).length,
    digestItemManifestChars: normalizeMarkdown(digestItemManifest).length,
    sourceIndexChars: normalizeMarkdown(sourceIndex).length,
    sourceIndexItemCount: indexItemCount,
    toolSchemasChars,
    instructionsChars: instructions.length,
    combinedChars,
    withinTargets: {
      baseInstructions:
        normalizeMarkdown(baseInstructions).length <=
        budgets.baseInstructionsChars,
      digestContext:
        normalizeMarkdown(digestContext).length <= budgets.digestContextChars,
      digestItemManifest:
        normalizeMarkdown(digestItemManifest).length <=
        budgets.digestItemManifestChars,
      sourceIndex:
        normalizeMarkdown(sourceIndex).length <= budgets.sourceIndexChars,
      sourceIndexItemCount: indexItemCount <= budgets.sourceIndexItemCount,
      combined: combinedChars <= budgets.combinedTargetChars,
    },
    withinHardCeiling: combinedChars <= budgets.combinedHardCeilingChars,
  };
}

export function buildPromptTokenCountRepresentation({
  instructions,
  tools = buildBriefingTools(),
  model = DEFAULT_BRIEFING_MODEL,
}: {
  instructions: string;
  tools?: BriefingToolDefinition[];
  model?: string;
}): BriefingPromptTokenCountRepresentation {
  return {
    model,
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: instructions,
          },
        ],
      },
    ],
    tools,
  };
}

export async function estimatePromptTokens({
  representation,
  apiKey = process.env.OPENAI_API_KEY,
  endpoint = "https://api.openai.com/v1/responses/input_tokens",
  fetchImplementation = globalThis.fetch?.bind(globalThis),
  timeoutMs = 5000,
}: {
  representation: BriefingPromptTokenCountRepresentation;
  apiKey?: string;
  endpoint?: string;
  fetchImplementation?: typeof fetch;
  timeoutMs?: number;
}): Promise<BriefingPromptTokenEstimate> {
  if (!apiKey) {
    return {
      available: false,
      reason: "missing_api_key",
    };
  }

  if (!fetchImplementation) {
    return {
      available: false,
      reason: "missing_fetch",
    };
  }

  const abortController =
    typeof AbortController === "function" ? new AbortController() : null;
  const timeout =
    abortController && timeoutMs > 0
      ? setTimeout(() => abortController.abort(), timeoutMs)
      : null;

  try {
    const response = await fetchImplementation(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(representation),
      signal: abortController?.signal,
    });
    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      return {
        available: false,
        reason: `http_${response.status}`,
        status: response.status,
        response: payload,
      };
    }

    const inputTokens = extractInputTokens(payload);
    if (typeof inputTokens !== "number") {
      return {
        available: false,
        reason: "invalid_response",
        response: payload,
      };
    }

    return {
      available: true,
      inputTokens,
      response: payload,
    };
  } catch (error) {
    const normalizedError =
      error instanceof Error ? error : new Error(String(error));
    return {
      available: false,
      reason:
        normalizedError.name === "AbortError" ? "timeout" : "request_failed",
      error: normalizedError.message,
    };
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export function buildBriefingPromptPayload({
  digest,
  sourceItems,
  baseInstructions = BRIEFING,
  tools = buildBriefingTools(),
  model = DEFAULT_BRIEFING_MODEL,
  budgets = briefingBudgetsForModel(model),
}: {
  digest: Pick<Digest, "content" | "source_item_ids">;
  sourceItems: BriefingSourceItem[];
  baseInstructions?: string;
  tools?: BriefingToolDefinition[];
  model?: string;
  budgets?: BriefingBudgetProfile;
}): BriefingPromptPayload {
  const composedBaseInstructions = composeBriefingBaseInstructions({
    baseInstructions,
    tools,
  });
  const digestCompactionSteps = digestCompactionStepsForBudget(budgets);
  const rankedSourceItems = rankBriefingSourceItems({
    digest,
    sourceItems,
  });
  let digestContext = buildBriefingDigestContext({
    content: digest.content,
  }, { budgets });
  let digestItemManifest = buildBriefingDigestItemManifest(sourceItems);
  let sourceIndex = buildBriefingSourceIndex(rankedSourceItems, { budgets });
  let stepsApplied = [...sourceIndex.stepsApplied];

  let instructions = buildBriefingInstructions({
    baseInstructions: composedBaseInstructions,
    digestContext: digestContext.text,
    digestItemManifest: digestItemManifest.text,
    sourceIndex: sourceIndex.text,
  });
  let budget = estimatePromptBudget({
    baseInstructions: composedBaseInstructions,
    digestContext: digestContext.text,
    digestItemManifest: digestItemManifest.text,
    sourceIndex: sourceIndex.text,
    tools,
    sourceIndexItemCount: sourceIndex.items.length,
    budgets,
  });

  const addStep = (step: BriefingBudgetFallbackStep) => {
    if (!stepsApplied.includes(step)) {
      stepsApplied = [...stepsApplied, step];
    }
  };

  const recomputePrompt = () => {
    instructions = buildBriefingInstructions({
      baseInstructions: composedBaseInstructions,
      digestContext: digestContext.text,
      digestItemManifest: digestItemManifest.text,
      sourceIndex: sourceIndex.text,
    });
    budget = estimatePromptBudget({
      baseInstructions: composedBaseInstructions,
      digestContext: digestContext.text,
      digestItemManifest: digestItemManifest.text,
      sourceIndex: sourceIndex.text,
      tools,
      sourceIndexItemCount: sourceIndex.items.length,
      budgets,
    });
  };

  if (
    !digestItemManifest.compactLabels &&
    (budget.digestItemManifestChars > budgets.digestItemManifestChars ||
      budget.combinedChars > budgets.combinedTargetChars)
  ) {
    digestItemManifest = buildBriefingDigestItemManifest(sourceItems, {
      compactLabels: true,
    });
    addStep("compact_manifest_labels");
    recomputePrompt();
  }

  if (
    budget.combinedChars > budgets.combinedTargetChars ||
    !budget.withinHardCeiling
  ) {
    for (const maxChars of digestCompactionSteps.slice(1)) {
      const candidateDigestContext = buildBriefingDigestContext(
        { content: digest.content },
        { maxChars, budgets },
      );
      const candidateInstructions = buildBriefingInstructions({
        baseInstructions: composedBaseInstructions,
        digestContext: candidateDigestContext.text,
        digestItemManifest: digestItemManifest.text,
        sourceIndex: sourceIndex.text,
      });
      const candidateBudget = estimatePromptBudget({
        baseInstructions: composedBaseInstructions,
        digestContext: candidateDigestContext.text,
        digestItemManifest: digestItemManifest.text,
        sourceIndex: sourceIndex.text,
        tools,
        sourceIndexItemCount: sourceIndex.items.length,
        budgets,
      });

      if (
        candidateBudget.combinedChars <= budget.combinedChars ||
        candidateBudget.digestContextChars <= budgets.digestContextChars
      ) {
        digestContext = candidateDigestContext;
        instructions = candidateInstructions;
        budget = candidateBudget;
      }

      if (
        candidateBudget.combinedChars <= budgets.combinedTargetChars &&
        candidateBudget.withinHardCeiling
      ) {
        break;
      }
    }

    addStep("compact_digest_context");
  }

  if (!budget.withinHardCeiling) {
    for (const fallback of SOURCE_INDEX_HARD_FALLBACKS) {
      const candidateSourceIndex = buildBriefingSourceIndex(rankedSourceItems, {
        ...fallback,
        budgets,
      });
      sourceIndex = candidateSourceIndex;
      for (const step of candidateSourceIndex.stepsApplied) {
        addStep(step);
      }
      if (candidateSourceIndex.items.length < budgets.sourceIndexItemCount) {
        addStep("drop_index_items");
      }
      if (candidateSourceIndex.charCount < budget.sourceIndexChars) {
        addStep("shorten_previews");
      }
      recomputePrompt();

      if (budget.withinHardCeiling) {
        break;
      }
    }
  }

  if (!budget.withinHardCeiling) {
    for (const maxChars of digestCompactionSteps.slice(4)) {
      const candidateDigestContext = buildBriefingDigestContext(
        { content: digest.content },
        { maxChars, budgets },
      );
      if (candidateDigestContext.charCount > digestContext.charCount) {
        continue;
      }

      digestContext = candidateDigestContext;
      addStep("compact_digest_context");
      recomputePrompt();

      if (budget.withinHardCeiling) {
        break;
      }
    }
  }

  return {
    baseInstructions: composedBaseInstructions,
    digestContext,
    digestItemManifest,
    sourceIndex,
    instructions,
    tools,
    budget,
    rankedSourceItems,
    stepsApplied,
  };
}
