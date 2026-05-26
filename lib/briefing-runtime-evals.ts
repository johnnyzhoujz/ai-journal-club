import type {
  BriefingTraceFlagAction,
  BriefingTraceFlagSeverity,
} from "@/lib/briefing-observability";
import type { BriefingToolName } from "@/lib/briefing-session";
import type { FeedItemSourceType } from "@/lib/schema";

export type BriefingRuntimeToolName = BriefingToolName;

export interface BriefingRuntimeToolCall {
  functionCallId: string;
  toolName: BriefingRuntimeToolName;
  arguments: Record<string, unknown>;
  responseId?: string | null;
  itemId?: string | null;
}

export interface BriefingRuntimeToolRecord {
  functionCallId: string;
  toolName: BriefingRuntimeToolName;
  arguments: Record<string, unknown>;
  output?: unknown;
}

export interface ArchiveTitleSourceMatch {
  title: string | null;
  sourceType: FeedItemSourceType;
}

export interface BriefingRuntimeEvalFlag {
  ruleId: string;
  severity: BriefingTraceFlagSeverity;
  action: BriefingTraceFlagAction;
  toolName?: BriefingRuntimeToolName | null;
  originalJson?: unknown;
  correctedJson?: unknown;
  detailsJson?: unknown;
}

export interface BriefingRuntimeToolCallEvalInput {
  currentUserTurn: string;
  assistantTextBeforeTool: string;
  proposedToolCall: BriefingRuntimeToolCall;
  previousToolCalls: BriefingRuntimeToolRecord[];
  archiveTitleSourceMatches?: ArchiveTitleSourceMatch[];
}

export interface BriefingRuntimeToolCallEvalResult {
  flags: BriefingRuntimeEvalFlag[];
  correctedArgs?: Record<string, unknown>;
  syntheticToolOutput?: unknown;
  advisoryGuidance?: string;
}

export interface BriefingRuntimeToolResultEvalInput {
  currentUserTurn: string;
  toolCall: BriefingRuntimeToolCall;
  toolOutput: unknown;
  previousToolCalls: BriefingRuntimeToolRecord[];
}

export interface BriefingRuntimeToolResultEvalResult {
  flags: BriefingRuntimeEvalFlag[];
  output: unknown;
}

export const MEMORY_ITEM_REQUIRES_SEARCH_MEMORY_RESULT_OUTPUT = {
  error: "memory_item_requires_search_memory_result",
  retryable: true,
  guidance:
    "Call search_memory first and pass a chunk id from its results. Do not use digest item ids or archive feed item ids as memory_id.",
} as const;

const SEARCH_OR_LIST_TOOLS = new Set<BriefingRuntimeToolName>([
  "search_memory",
  "search_archive",
  "list_archive_items",
]);

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
] as const;

const MEMORY_META_WORD_PATTERN = /\b(digest|today|yesterday)\b/i;
const EXACT_PASSAGE_PATTERN =
  /\b(exact|verbatim|quote|quoted|full|entire|passage|transcript|word[- ]for[- ]word)\b/i;
const EMPTY_MEMORY_RETRY_INTENT_PATTERN =
  /\b(?:have|did|do)\s+we\s+(?:cover(?:ed)?|see(?:n)?|talk(?:ed)?\s+about|mention(?:ed)?|discuss(?:ed)?|reference(?:d)?)\b|\bany\s+(?:mentions?|references?|coverage)\s+(?:of|for|about|to|on)\b/i;
const HIGH_STAKES_PATTERN =
  /\b(medical|clinical|dosage|dose|prescription|diagnosis|treatment|legal|lawyer|attorney|lawsuit|liability|regulatory|compliance)\b/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function sourceFromUserTurn(userTurn: string): FeedItemSourceType | null {
  const normalized = userTurn.toLowerCase();
  if (/\b(paper|papers|arxiv|research)\b/.test(normalized)) {
    return "paper";
  }
  if (/\b(podcast|podcasts|episode|episodes)\b/.test(normalized)) {
    return "podcast";
  }
  if (/\b(newsletter|newsletters|article|articles)\b/.test(normalized)) {
    return "newsletter";
  }
  if (/\b(tweet|tweets|x post|x posts)\b/.test(normalized)) {
    return "tweet";
  }
  return null;
}

function parseExplicitMonthRange(userTurn: string):
  | {
      year: number;
      monthIndex: number;
      lastDay: string;
      nextMonthFirstDay: string;
    }
  | null {
  const pattern = new RegExp(
    `\\b(${MONTHS.join("|")})\\s+(20\\d{2})\\b`,
    "i",
  );
  const match = userTurn.match(pattern);
  if (!match) {
    return null;
  }

  const monthIndex = MONTHS.indexOf(match[1].toLowerCase() as (typeof MONTHS)[number]);
  const year = Number.parseInt(match[2], 10);
  if (monthIndex < 0 || !Number.isInteger(year)) {
    return null;
  }

  const lastDayDate = new Date(Date.UTC(year, monthIndex + 1, 0));
  const nextMonthDate = new Date(Date.UTC(year, monthIndex + 1, 1));

  return {
    year,
    monthIndex,
    lastDay: lastDayDate.toISOString().slice(0, 10),
    nextMonthFirstDay: nextMonthDate.toISOString().slice(0, 10),
  };
}

function dateOnly(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)
    ? value.slice(0, 10)
    : null;
}

function cloneArgs(args: Record<string, unknown>): Record<string, unknown> {
  return { ...args };
}

function hasUsableMemorySnippet(output: unknown, memoryId: number | null): boolean {
  if (!isRecord(output) || !Array.isArray(output.results)) {
    return false;
  }

  return output.results.some((result) => {
    if (!isRecord(result)) {
      return false;
    }
    if (memoryId != null && result.id !== memoryId) {
      return false;
    }
    if (result.source_type === "paper") {
      return false;
    }
    return typeof result.snippet === "string" && normalizeWhitespace(result.snippet).length >= 80;
  });
}

function isEmptyResultSet(output: unknown): boolean {
  return isRecord(output) && Array.isArray(output.results) && output.results.length === 0;
}

function findPreviousSearchMemory(
  previousToolCalls: BriefingRuntimeToolRecord[],
): BriefingRuntimeToolRecord | null {
  for (let index = previousToolCalls.length - 1; index >= 0; index -= 1) {
    const call = previousToolCalls[index];
    if (call.toolName === "search_memory") {
      return call;
    }
  }
  return null;
}

export function searchMemoryOutputHasMemoryId(
  output: unknown,
  memoryId: number,
): boolean {
  if (!isRecord(output) || !Array.isArray(output.results)) {
    return false;
  }

  return output.results.some((result) => {
    return isRecord(result) && result.kind === "chunk" && result.id === memoryId;
  });
}

function previousSearchMemoryReturnedMemoryId(
  previousToolCalls: BriefingRuntimeToolRecord[],
  memoryId: number,
): boolean {
  return previousToolCalls.some(
    (call) =>
      call.toolName === "search_memory" &&
      searchMemoryOutputHasMemoryId(call.output, memoryId),
  );
}

export function normalizeSearchArchiveSourceFromExactTitle({
  args,
  archiveTitleSourceMatches,
}: {
  args: Record<string, unknown>;
  archiveTitleSourceMatches?: ArchiveTitleSourceMatch[];
}): Record<string, unknown> | null {
  if (
    typeof args.query !== "string" ||
    (args.source !== undefined && args.source !== "all")
  ) {
    return null;
  }

  const normalizedQuery = normalizeWhitespace(args.query).toLowerCase();
  const matches = (archiveTitleSourceMatches ?? []).filter(
    (match) =>
      typeof match.title === "string" &&
      normalizeWhitespace(match.title).toLowerCase() === normalizedQuery,
  );
  const uniqueSources = new Set(matches.map((match) => match.sourceType));

  if (matches.length !== 1 || uniqueSources.size !== 1) {
    return null;
  }

  return {
    ...args,
    source: matches[0].sourceType,
  };
}

export function evaluateBriefingRuntimeToolCall(
  input: BriefingRuntimeToolCallEvalInput,
): BriefingRuntimeToolCallEvalResult {
  const { currentUserTurn, proposedToolCall } = input;
  const flags: BriefingRuntimeEvalFlag[] = [];
  let correctedArgs: Record<string, unknown> | undefined;

  const nextArgs = () => {
    correctedArgs ??= cloneArgs(proposedToolCall.arguments);
    return correctedArgs;
  };

  const expectedSource = sourceFromUserTurn(currentUserTurn);
  if (
    expectedSource &&
    SEARCH_OR_LIST_TOOLS.has(proposedToolCall.toolName) &&
    (proposedToolCall.arguments.source === undefined ||
      proposedToolCall.arguments.source === "all")
  ) {
    const args = nextArgs();
    args.source = expectedSource;
    flags.push({
      ruleId: "source_filter_injected",
      severity: "warning",
      action: "normalized_args",
      toolName: proposedToolCall.toolName,
      originalJson: proposedToolCall.arguments,
      correctedJson: args,
      detailsJson: {
        expectedSource,
      },
    });
  }

  const monthRange = parseExplicitMonthRange(currentUserTurn);
  const before = dateOnly((correctedArgs ?? proposedToolCall.arguments).before);
  if (monthRange && before === monthRange.nextMonthFirstDay) {
    const args = nextArgs();
    args.before = monthRange.lastDay;
    flags.push({
      ruleId: "month_before_normalized",
      severity: "warning",
      action: "normalized_args",
      toolName: proposedToolCall.toolName,
      originalJson: proposedToolCall.arguments,
      correctedJson: args,
      detailsJson: {
        originalBefore: before,
        correctedBefore: monthRange.lastDay,
      },
    });
  }

  if (proposedToolCall.toolName === "search_archive") {
    const exactTitleArgs = normalizeSearchArchiveSourceFromExactTitle({
      args: correctedArgs ?? proposedToolCall.arguments,
      archiveTitleSourceMatches: input.archiveTitleSourceMatches,
    });
    if (exactTitleArgs) {
      correctedArgs = exactTitleArgs;
      flags.push({
        ruleId: "exact_archive_title_source_inferred",
        severity: "warning",
        action: "normalized_args",
        toolName: proposedToolCall.toolName,
        originalJson: proposedToolCall.arguments,
        correctedJson: correctedArgs,
      });
    }
  }

  if (
    proposedToolCall.toolName === "search_memory" &&
    typeof (correctedArgs ?? proposedToolCall.arguments).query === "string" &&
    MEMORY_META_WORD_PATTERN.test(
      (correctedArgs ?? proposedToolCall.arguments).query as string,
    )
  ) {
    flags.push({
      ruleId: "memory_query_meta_words",
      severity: "info",
      action: "logged",
      toolName: proposedToolCall.toolName,
      detailsJson: {
        query: (correctedArgs ?? proposedToolCall.arguments).query,
      },
    });
  }

  if (proposedToolCall.toolName === "get_memory_item") {
    const memoryId =
      typeof proposedToolCall.arguments.memory_id === "number"
        ? proposedToolCall.arguments.memory_id
        : null;
    if (
      memoryId != null &&
      !previousSearchMemoryReturnedMemoryId(input.previousToolCalls, memoryId)
    ) {
      flags.push({
        ruleId: "get_memory_item_without_search_memory_result",
        severity: "warning",
        action: "blocked_tool",
        toolName: proposedToolCall.toolName,
        originalJson: proposedToolCall.arguments,
        detailsJson: MEMORY_ITEM_REQUIRES_SEARCH_MEMORY_RESULT_OUTPUT,
      });
      return {
        flags,
        correctedArgs,
        syntheticToolOutput: MEMORY_ITEM_REQUIRES_SEARCH_MEMORY_RESULT_OUTPUT,
      };
    }

    const previousMemorySearch = findPreviousSearchMemory(input.previousToolCalls);
    if (
      previousMemorySearch &&
      hasUsableMemorySnippet(previousMemorySearch.output, memoryId) &&
      !EXACT_PASSAGE_PATTERN.test(currentUserTurn)
    ) {
      const syntheticToolOutput = {
        skipped: true,
        reason: "search_memory_snippet_sufficient",
        guidance:
          "Use the prior search_memory snippets as evidence. Do not fetch the full memory item unless the user asks for exact wording or a full passage.",
      };
      flags.push({
        ruleId: "unnecessary_get_memory_item_blocked",
        severity: "warning",
        action: "blocked_tool",
        toolName: proposedToolCall.toolName,
        originalJson: proposedToolCall.arguments,
        detailsJson: syntheticToolOutput,
      });
      return {
        flags,
        correctedArgs,
        syntheticToolOutput,
      };
    }
  }

  if (
    proposedToolCall.toolName === "search_archive" &&
    HIGH_STAKES_PATTERN.test(currentUserTurn)
  ) {
    const previousMemorySearch = findPreviousSearchMemory(input.previousToolCalls);
    if (previousMemorySearch && isEmptyResultSet(previousMemorySearch.output)) {
      const syntheticToolOutput = {
        results: [],
        blocked: true,
        reason: "high_stakes_memory_search_empty",
        guidance:
          "The prior memory search found no supporting evidence for this high-stakes claim. Answer that the archive does not support it instead of falling back to broad archive search.",
      };
      flags.push({
        ruleId: "high_stakes_archive_fallback_blocked",
        severity: "error",
        action: "blocked_tool",
        toolName: proposedToolCall.toolName,
        originalJson: proposedToolCall.arguments,
        detailsJson: syntheticToolOutput,
      });
      return {
        flags,
        correctedArgs,
        syntheticToolOutput,
      };
    }
  }

  return {
    flags,
    correctedArgs,
  };
}

export function evaluateBriefingRuntimeToolResult(
  input: BriefingRuntimeToolResultEvalInput,
): BriefingRuntimeToolResultEvalResult {
  const flags: BriefingRuntimeEvalFlag[] = [];

  if (
    input.toolCall.toolName === "search_memory" &&
    isEmptyResultSet(input.toolOutput) &&
    EMPTY_MEMORY_RETRY_INTENT_PATTERN.test(input.currentUserTurn)
  ) {
    const priorEmptyRetries = input.previousToolCalls.filter(
      (call) => call.toolName === "search_memory" && isEmptyResultSet(call.output),
    ).length;

    if (priorEmptyRetries === 0) {
      const guidance =
        "No memory results were found. Before answering no, retry search_memory once with a rewritten query that removes date/digest wording and keeps only topic/entity terms.";
      flags.push({
        ruleId: "empty_memory_retry_nudge",
        severity: "info",
        action: "nudged",
        toolName: input.toolCall.toolName,
        detailsJson: {
          guidance,
        },
      });

      if (isRecord(input.toolOutput)) {
        return {
          flags,
          output: {
            ...input.toolOutput,
            guidance,
          },
        };
      }

      return {
        flags,
        output: {
          result: input.toolOutput,
          guidance,
        },
      };
    }
  }

  return {
    flags,
    output: input.toolOutput,
  };
}
