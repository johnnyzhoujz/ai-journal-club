import { sql } from "@/lib/db";
import { formatDigestItemToolResult } from "@/lib/briefing";
import {
  VALID_ARCHIVE_SEARCH_SOURCES,
  listArchiveItemsForTool,
  searchArchiveForTool,
} from "@/lib/archive-search";
import {
  SUPPORTED_MEMORY_SEARCH_MODES,
  SUPPORTED_MEMORY_SEARCH_SCOPES,
  VALID_PAPER_CORPUS_SCOPES,
  VALID_MEMORY_SEARCH_SOURCES,
  getMemoryItemForTool,
  isMemoryReadsEnabled,
  normalizeMemorySearchLimit,
  searchMemoryForTool,
} from "@/lib/memory-retrieval";
import {
  isBriefingObservabilityEnabled,
  recordBriefingTraceEvent,
  recordBriefingTraceFlag,
  summarizeToolOutputForTrace,
} from "@/lib/briefing-observability";
import {
  MEMORY_ITEM_REQUIRES_SEARCH_MEMORY_RESULT_OUTPUT,
  normalizeSearchArchiveSourceFromExactTitle,
  searchMemoryOutputHasMemoryId,
} from "@/lib/briefing-runtime-evals";
import {
  claimHandledCallExecution,
  completeHandledCall,
  failHandledCall,
  getBriefingSession,
  getHandledCallRecord,
  type BriefingToolName,
} from "@/lib/briefing-session";
import {
  DEFAULT_BRIEFING_RATE_LIMITS,
  MissingClientIpError,
  consumeRateLimit,
  deriveClientIpInfo,
} from "@/lib/rate-limit";
import type {
  FeedItem,
  MemoryItemKind,
  PaperCorpusScope,
  MemorySearchMode,
  MemorySearchScope,
  MemorySearchSource,
} from "@/lib/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

const KNOWN_TOOL_NAMES = new Set<BriefingToolName>([
  "get_digest_item",
  "search_archive",
  "list_archive_items",
  "search_memory",
  "get_memory_item",
]);
const VALID_SEARCH_SOURCES = new Set<string>(VALID_ARCHIVE_SEARCH_SOURCES);
const VALID_MEMORY_SOURCES = new Set<string>(VALID_MEMORY_SEARCH_SOURCES);
const VALID_MEMORY_SCOPES = new Set<string>(SUPPORTED_MEMORY_SEARCH_SCOPES);
const VALID_PAPER_CORPUS_SCOPE_VALUES = new Set<string>(VALID_PAPER_CORPUS_SCOPES);
const VALID_MEMORY_MODES = new Set<string>(SUPPORTED_MEMORY_SEARCH_MODES);
const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 20;
const DEFAULT_ARCHIVE_LIST_LIMIT = 20;
const MAX_ARCHIVE_LIST_LIMIT = 20;
const MAX_COMBINED_SNIPPET_CHARS = 2_000;
const RETRIEVAL_FAILED_OUTPUT = {
  error: "retrieval_failed",
  retryable: true,
} as const;
const TOOL_BUDGET_EXHAUSTED_OUTPUT = {
  error: "tool_budget_exhausted",
  retryable: false,
} as const;

type ToolRequestBody = {
  briefingSessionId: string;
  functionCallId: string;
  toolName: BriefingToolName;
  arguments: Record<string, unknown>;
};

type ParsedGetDigestItemArguments = {
  itemId: number;
};

type ParsedSearchArchiveArguments = {
  query: string;
  source: (typeof VALID_ARCHIVE_SEARCH_SOURCES)[number];
  after: string | null;
  before: string | null;
  limit: number;
};

type ParsedListArchiveItemsArguments = {
  source: (typeof VALID_ARCHIVE_SEARCH_SOURCES)[number];
  author: string | null;
  after: string | null;
  before: string | null;
  limit: number;
  offset: number;
};

type ParsedSearchMemoryArguments = {
  query: string;
  scope: Extract<MemorySearchScope, "all" | "chunk">;
  source: MemorySearchSource;
  paperCorpusScope: PaperCorpusScope;
  mode: MemorySearchMode;
  currentDigestOnly: boolean;
  after: string | null;
  before: string | null;
  limit: number;
};

type ParsedGetMemoryItemArguments = {
  memoryKind: Extract<MemoryItemKind, "chunk">;
  memoryId: number;
};

type ExactArchiveTitleSourceRow = {
  title: string | null;
  source_type: FeedItem["source_type"];
  match_count: number | string;
};

type PriorSearchMemoryResultRow = {
  result_payload: unknown;
};

function jsonError(error: string, status = 500) {
  return Response.json({ error }, { status });
}

function toolSuccess(functionCallId: string, output: unknown) {
  return Response.json({
    ok: true,
    functionCallId,
    output,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseRequestBody(value: unknown): ToolRequestBody | null {
  if (!isRecord(value)) {
    return null;
  }

  const { briefingSessionId, functionCallId, toolName, arguments: args } = value;
  if (
    typeof briefingSessionId !== "string" ||
    !briefingSessionId.trim() ||
    typeof functionCallId !== "string" ||
    !functionCallId.trim() ||
    typeof toolName !== "string" ||
    !KNOWN_TOOL_NAMES.has(toolName as BriefingToolName) ||
    !isRecord(args)
  ) {
    return null;
  }

  return {
    briefingSessionId,
    functionCallId,
    toolName: toolName as BriefingToolName,
    arguments: args,
  };
}

function isToolEnabled(toolName: BriefingToolName): boolean {
  if (toolName === "search_memory" || toolName === "get_memory_item") {
    return isMemoryReadsEnabled();
  }

  return true;
}

function parseGetDigestItemArguments(
  value: Record<string, unknown>,
): ParsedGetDigestItemArguments | null {
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "item_id") {
    return null;
  }

  if (!Number.isInteger(value.item_id)) {
    return null;
  }

  return {
    itemId: value.item_id as number,
  };
}

function parseSearchArchiveArguments(
  value: Record<string, unknown>,
): ParsedSearchArchiveArguments | null {
  const keys = Object.keys(value);
  const allowedKeys = new Set(["query", "source", "after", "before", "limit"]);

  if (keys.some((key) => !allowedKeys.has(key))) {
    return null;
  }

  if (typeof value.query !== "string" || !value.query.trim()) {
    return null;
  }

  const source = typeof value.source === "string" ? value.source : "all";
  if (!VALID_SEARCH_SOURCES.has(source)) {
    return null;
  }

  const after =
    value.after === undefined
      ? null
      : typeof value.after === "string"
        ? value.after
        : null;
  const before =
    value.before === undefined
      ? null
      : typeof value.before === "string"
        ? value.before
        : null;

  if ((value.after !== undefined && after === null) || (value.before !== undefined && before === null)) {
    return null;
  }

  const limit =
    value.limit === undefined
      ? DEFAULT_SEARCH_LIMIT
      : Number.isInteger(value.limit) && (value.limit as number) >= 1 && (value.limit as number) <= MAX_SEARCH_LIMIT
        ? (value.limit as number)
        : null;

  if (limit === null) {
    return null;
  }

  return {
    query: value.query.trim(),
    source: source as ParsedSearchArchiveArguments["source"],
    after,
    before,
    limit,
  };
}

function parseListArchiveItemsArguments(
  value: Record<string, unknown>,
): ParsedListArchiveItemsArguments | null {
  const keys = Object.keys(value);
  const allowedKeys = new Set(["source", "author", "after", "before", "limit", "offset"]);

  if (keys.some((key) => !allowedKeys.has(key))) {
    return null;
  }

  const source = typeof value.source === "string" ? value.source : "all";
  if (!VALID_SEARCH_SOURCES.has(source)) {
    return null;
  }

  const author =
    value.author === undefined || value.author === null
      ? null
      : typeof value.author === "string" && value.author.trim()
        ? value.author.trim()
        : null;
  const after =
    value.after === undefined || value.after === null
      ? null
      : typeof value.after === "string"
        ? value.after
        : null;
  const before =
    value.before === undefined || value.before === null
      ? null
      : typeof value.before === "string"
        ? value.before
        : null;

  if (
    (value.author !== undefined && value.author !== null && author === null) ||
    (value.after !== undefined && after === null) ||
    (value.before !== undefined && before === null)
  ) {
    return null;
  }

  const limit =
    value.limit === undefined
      ? DEFAULT_ARCHIVE_LIST_LIMIT
      : Number.isInteger(value.limit) &&
          (value.limit as number) >= 1 &&
          (value.limit as number) <= MAX_ARCHIVE_LIST_LIMIT
        ? (value.limit as number)
        : null;
  const offset =
    value.offset === undefined
      ? 0
      : Number.isInteger(value.offset) && (value.offset as number) >= 0
        ? (value.offset as number)
        : null;

  if (limit === null || offset === null) {
    return null;
  }

  return {
    source: source as ParsedListArchiveItemsArguments["source"],
    author,
    after,
    before,
    limit,
    offset,
  };
}

function parseSearchMemoryArguments(
  value: Record<string, unknown>,
): ParsedSearchMemoryArguments | null {
  const keys = Object.keys(value);
  const allowedKeys = new Set([
    "query",
    "scope",
    "source",
    "paperCorpusScope",
    "mode",
    "currentDigestOnly",
    "after",
    "before",
    "limit",
  ]);

  if (keys.some((key) => !allowedKeys.has(key))) {
    return null;
  }

  if (typeof value.query !== "string" || !value.query.trim()) {
    return null;
  }

  const scope = typeof value.scope === "string" ? value.scope : "all";
  if (!VALID_MEMORY_SCOPES.has(scope)) {
    return null;
  }

  const source = typeof value.source === "string" ? value.source : "all";
  if (!VALID_MEMORY_SOURCES.has(source)) {
    return null;
  }

  const paperCorpusScope =
    typeof value.paperCorpusScope === "string" ? value.paperCorpusScope : "default";
  if (!VALID_PAPER_CORPUS_SCOPE_VALUES.has(paperCorpusScope)) {
    return null;
  }

  const mode =
    typeof value.mode === "string"
      ? value.mode
      : source === "paper"
        ? "evidence"
        : "discovery";
  if (!VALID_MEMORY_MODES.has(mode)) {
    return null;
  }

  const currentDigestOnly =
    value.currentDigestOnly === undefined
      ? true
      : typeof value.currentDigestOnly === "boolean"
        ? value.currentDigestOnly
        : null;

  const after =
    value.after === undefined
      ? null
      : typeof value.after === "string"
        ? value.after
        : null;
  const before =
    value.before === undefined
      ? null
      : typeof value.before === "string"
        ? value.before
        : null;

  if (
    currentDigestOnly === null ||
    (value.after !== undefined && after === null) ||
    (value.before !== undefined && before === null)
  ) {
    return null;
  }

  if (
    value.limit !== undefined &&
    (!Number.isInteger(value.limit) || (value.limit as number) <= 0)
  ) {
    return null;
  }

  return {
    query: value.query.trim(),
    scope: scope as ParsedSearchMemoryArguments["scope"],
    source: source as MemorySearchSource,
    paperCorpusScope: paperCorpusScope as PaperCorpusScope,
    mode: mode as MemorySearchMode,
    currentDigestOnly,
    after,
    before,
    limit: normalizeMemorySearchLimit(value.limit as number | undefined),
  };
}

function parseGetMemoryItemArguments(
  value: Record<string, unknown>,
): ParsedGetMemoryItemArguments | null {
  const keys = Object.keys(value);
  const allowedKeys = new Set(["memory_kind", "memory_id"]);

  if (keys.some((key) => !allowedKeys.has(key))) {
    return null;
  }

  if (value.memory_kind !== "chunk") {
    return null;
  }

  if (
    !Number.isInteger(value.memory_id) ||
    (value.memory_id as number) <= 0
  ) {
    return null;
  }

  return {
    memoryKind: value.memory_kind,
    memoryId: value.memory_id as number,
  };
}

function mapCompletedState(functionCallId: string, output: unknown) {
  return toolSuccess(functionCallId, output);
}

async function loadDigestItem(itemId: number): Promise<FeedItem | null> {
  const rows = (await sql`
    SELECT *
    FROM feed_items
    WHERE id = ${itemId}
    LIMIT 1
  `) as FeedItem[];

  return rows[0] ?? null;
}

async function loadUniqueExactArchiveTitleSource(
  query: string,
): Promise<ExactArchiveTitleSourceRow | null> {
  const rows = (await sql`
    SELECT title, source_type, COUNT(*) OVER() AS match_count
    FROM feed_items
    WHERE title IS NOT NULL
      AND LOWER(title) = LOWER(${query})
    LIMIT 2
  `) as ExactArchiveTitleSourceRow[];

  if (rows.length !== 1 || Number(rows[0].match_count) !== 1) {
    return null;
  }

  return rows[0];
}

function normalizeArchiveResults<
  T extends {
    snippet: string;
  },
>(results: T[]): T[] {
  let totalChars = 0;
  const bounded: T[] = [];

  for (const result of results) {
    const snippet = result.snippet.replace(/\s+/g, " ").trim();
    if (!snippet) {
      continue;
    }

    if (totalChars + snippet.length > MAX_COMBINED_SNIPPET_CHARS) {
      const remaining = MAX_COMBINED_SNIPPET_CHARS - totalChars;
      if (remaining <= 0) {
        break;
      }

      bounded.push({
        ...result,
        snippet: snippet.slice(0, remaining).trim(),
      });
      break;
    }

    bounded.push({
      ...result,
      snippet,
    });
    totalChars += snippet.length;
  }

  return bounded;
}

function parseStoredJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

async function wasMemoryIdReturnedByPriorSearchMemory(
  briefingSessionId: string,
  memoryId: number,
): Promise<boolean> {
  const rows = (await sql`
    SELECT result_payload
    FROM briefing_handled_calls
    WHERE briefing_session_id = ${briefingSessionId}
      AND tool_name = 'search_memory'
      AND status = 'completed'
      AND result_payload IS NOT NULL
    ORDER BY created_at DESC, updated_at DESC
    LIMIT 25
  `) as PriorSearchMemoryResultRow[];

  return rows.some((row) =>
    searchMemoryOutputHasMemoryId(parseStoredJson(row.result_payload), memoryId),
  );
}

async function failClaimedCall(
  briefingSessionId: string,
  functionCallId: string,
  toolName: BriefingToolName,
  attemptCount: number,
  lastError: string,
) {
  await failHandledCall({
    briefingSessionId,
    functionCallId,
    toolName,
    attemptCount,
    lastError,
  });
}

async function buildSessionUnavailableResponse(briefingSessionId: string) {
  const session = await getBriefingSession(briefingSessionId);

  if (!session || session.closedAt) {
    return jsonError("invalid_session", 404);
  }

  if (Date.parse(session.expiresAt) <= Date.now()) {
    return jsonError("session_expired", 410);
  }

  return jsonError("briefing_tool_failed", 500);
}

async function resolveStaleAttemptResponse(
  briefingSessionId: string,
  functionCallId: string,
) {
  const handledCall = await getHandledCallRecord(briefingSessionId, functionCallId);
  if (!handledCall) {
    return jsonError("briefing_tool_failed", 500);
  }

  if (handledCall.status === "completed") {
    return mapCompletedState(functionCallId, handledCall.resultPayload);
  }

  if (handledCall.status === "pending") {
    return jsonError("tool_call_in_progress", 409);
  }

  return jsonError("briefing_tool_failed", 500);
}

async function persistRelayableOutput(
  requestBody: ToolRequestBody,
  attemptCount: number,
  output: unknown,
  spendBudget: boolean,
  traceOptions?: {
    startedAt: number;
    requestEventId: number | null;
  },
) {
  let completion = await completeHandledCall({
    briefingSessionId: requestBody.briefingSessionId,
    functionCallId: requestBody.functionCallId,
    toolName: requestBody.toolName,
    attemptCount,
    resultPayload: output,
    spendBudget,
  });

  let responseOutput = output;

  if (completion.status === "budget_exhausted") {
    responseOutput = TOOL_BUDGET_EXHAUSTED_OUTPUT;
    completion = await completeHandledCall({
      briefingSessionId: requestBody.briefingSessionId,
      functionCallId: requestBody.functionCallId,
      toolName: requestBody.toolName,
      attemptCount,
      resultPayload: responseOutput,
      spendBudget: false,
    });
  }

  if (completion.status === "completed") {
    await recordBriefingTraceEvent({
      briefingSessionId: requestBody.briefingSessionId,
      eventType: "tool.result",
      source: "server",
      functionCallId: requestBody.functionCallId,
      toolName: requestBody.toolName,
      resultSummaryJson: summarizeToolOutputForTrace(responseOutput),
      latencyMs: traceOptions ? Date.now() - traceOptions.startedAt : null,
    });
    return mapCompletedState(requestBody.functionCallId, responseOutput);
  }

  if (completion.status === "session_unavailable") {
    await failClaimedCall(
      requestBody.briefingSessionId,
      requestBody.functionCallId,
      requestBody.toolName,
      attemptCount,
      "session_unavailable",
    );
    return buildSessionUnavailableResponse(requestBody.briefingSessionId);
  }

  return resolveStaleAttemptResponse(
    requestBody.briefingSessionId,
    requestBody.functionCallId,
  );
}

export async function POST(request: Request) {
  let requestBody: ToolRequestBody | null = null;

  try {
    let rawBody: unknown;

    try {
      rawBody = await request.json();
    } catch {
      return jsonError("invalid_request_body", 400);
    }

    requestBody = parseRequestBody(rawBody);
    if (!requestBody) {
      return jsonError("invalid_request_body", 400);
    }

    if (!isToolEnabled(requestBody.toolName)) {
      return jsonError("invalid_request_body", 400);
    }

    const { clientIpHash } = deriveClientIpInfo(request.headers);

    const rateLimit = await consumeRateLimit({
      headers: request.headers,
      routeKey: "briefing/tool",
      limit: DEFAULT_BRIEFING_RATE_LIMITS.tool,
    });

    if (!rateLimit.allowed) {
      return jsonError("rate_limited", 429);
    }

    const session = await getBriefingSession(requestBody.briefingSessionId);
    if (!session || session.closedAt) {
      return jsonError("invalid_session", 404);
    }

    if (session.clientIpHash !== clientIpHash) {
      return jsonError("invalid_session", 404);
    }

    if (Date.parse(session.expiresAt) <= Date.now()) {
      return jsonError("session_expired", 410);
    }

    const claimed = await claimHandledCallExecution({
      briefingSessionId: requestBody.briefingSessionId,
      functionCallId: requestBody.functionCallId,
      toolName: requestBody.toolName,
      requestArguments: requestBody.arguments,
    });

    if (claimed.disposition === "replay") {
      return mapCompletedState(
        requestBody.functionCallId,
        claimed.record.resultPayload,
      );
    }

    if (claimed.disposition === "pending") {
      return jsonError("tool_call_in_progress", 409);
    }

    if (claimed.disposition === "tool_mismatch") {
      return jsonError("invalid_request_body", 400);
    }

    const traceStartedAt = Date.now();
    const requestTraceEventId = await recordBriefingTraceEvent({
      briefingSessionId: requestBody.briefingSessionId,
      eventType: "tool.request",
      source: "server",
      functionCallId: requestBody.functionCallId,
      toolName: requestBody.toolName,
      argumentsJson: requestBody.arguments,
    });
    const traceOptions = {
      startedAt: traceStartedAt,
      requestEventId: requestTraceEventId,
    };

    if (
      isBriefingObservabilityEnabled() &&
      requestBody.toolName === "search_archive" &&
      typeof requestBody.arguments.query === "string" &&
      (requestBody.arguments.source === undefined ||
        requestBody.arguments.source === "all")
    ) {
      try {
        const exactTitleSource = await loadUniqueExactArchiveTitleSource(
          requestBody.arguments.query,
        );
        const correctedArguments = normalizeSearchArchiveSourceFromExactTitle({
          args: requestBody.arguments,
          archiveTitleSourceMatches: exactTitleSource
            ? [
                {
                  title: exactTitleSource.title,
                  sourceType: exactTitleSource.source_type,
                },
              ]
            : [],
        });

        if (correctedArguments) {
          await recordBriefingTraceFlag({
            briefingSessionId: requestBody.briefingSessionId,
            ruleId: "exact_archive_title_source_inferred",
            severity: "warning",
            action: "normalized_args",
            eventId: requestTraceEventId,
            toolName: requestBody.toolName,
            originalJson: requestBody.arguments,
            correctedJson: correctedArguments,
          });
          requestBody.arguments = correctedArguments;
        }
      } catch (error) {
        console.error("briefing.tool.exact_title_source_normalization_failed", {
          briefingSessionId: requestBody.briefingSessionId,
          functionCallId: requestBody.functionCallId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (requestBody.toolName === "get_digest_item") {
      const parsedArguments = parseGetDigestItemArguments(requestBody.arguments);
      if (!parsedArguments) {
        await failClaimedCall(
          requestBody.briefingSessionId,
          requestBody.functionCallId,
          requestBody.toolName,
          claimed.record.attemptCount,
          "invalid_arguments",
        );
        return jsonError("invalid_arguments", 400);
      }

      if (!session.sourceItemIds.includes(parsedArguments.itemId)) {
        await failClaimedCall(
          requestBody.briefingSessionId,
          requestBody.functionCallId,
          requestBody.toolName,
          claimed.record.attemptCount,
          "item_out_of_scope",
        );
        return jsonError("invalid_arguments", 400);
      }

      try {
        const item = await loadDigestItem(parsedArguments.itemId);
        if (!item) {
          return persistRelayableOutput(
            requestBody,
            claimed.record.attemptCount,
            RETRIEVAL_FAILED_OUTPUT,
            false,
            traceOptions,
          );
        }

        return persistRelayableOutput(
          requestBody,
          claimed.record.attemptCount,
          formatDigestItemToolResult(item),
          true,
          traceOptions,
        );
      } catch (error) {
        console.error("briefing.tool.get_digest_item_failed", {
          briefingSessionId: requestBody.briefingSessionId,
          functionCallId: requestBody.functionCallId,
          digestId: session.digestId,
          error: error instanceof Error ? error.message : String(error),
        });

        return persistRelayableOutput(
          requestBody,
          claimed.record.attemptCount,
          RETRIEVAL_FAILED_OUTPUT,
          false,
          traceOptions,
        );
      }
    }

    if (requestBody.toolName === "search_memory") {
      const parsedArguments = parseSearchMemoryArguments(requestBody.arguments);
      if (!parsedArguments) {
        await failClaimedCall(
          requestBody.briefingSessionId,
          requestBody.functionCallId,
          requestBody.toolName,
          claimed.record.attemptCount,
          "invalid_arguments",
        );
        return jsonError("invalid_arguments", 400);
      }

      try {
        const feedItemIds =
          parsedArguments.currentDigestOnly && session.sourceItemIds.length > 0
            ? session.sourceItemIds
            : undefined;
        const result = await searchMemoryForTool({
          query: parsedArguments.query,
          scope: parsedArguments.scope,
          source: parsedArguments.source,
          paperCorpusScope: parsedArguments.paperCorpusScope,
          mode: parsedArguments.mode,
          feedItemIds,
          after: parsedArguments.after,
          before: parsedArguments.before,
          limit: parsedArguments.limit,
        });

        return persistRelayableOutput(
          requestBody,
          claimed.record.attemptCount,
          result,
          true,
          traceOptions,
        );
      } catch (error) {
        console.error("briefing.tool.search_memory_failed", {
          briefingSessionId: requestBody.briefingSessionId,
          functionCallId: requestBody.functionCallId,
          digestId: session.digestId,
          error: error instanceof Error ? error.message : String(error),
        });

        return persistRelayableOutput(
          requestBody,
          claimed.record.attemptCount,
          RETRIEVAL_FAILED_OUTPUT,
          false,
          traceOptions,
        );
      }
    }

    if (requestBody.toolName === "get_memory_item") {
      const parsedArguments = parseGetMemoryItemArguments(requestBody.arguments);
      if (!parsedArguments) {
        await failClaimedCall(
          requestBody.briefingSessionId,
          requestBody.functionCallId,
          requestBody.toolName,
          claimed.record.attemptCount,
          "invalid_arguments",
        );
        return jsonError("invalid_arguments", 400);
      }

      try {
        const wasReturnedBySearchMemory =
          await wasMemoryIdReturnedByPriorSearchMemory(
            requestBody.briefingSessionId,
            parsedArguments.memoryId,
          );

        if (!wasReturnedBySearchMemory) {
          await recordBriefingTraceFlag({
            briefingSessionId: requestBody.briefingSessionId,
            ruleId: "get_memory_item_without_search_memory_result",
            severity: "warning",
            action: "blocked_tool",
            eventId: requestTraceEventId,
            toolName: requestBody.toolName,
            originalJson: requestBody.arguments,
            detailsJson: MEMORY_ITEM_REQUIRES_SEARCH_MEMORY_RESULT_OUTPUT,
          });

          return persistRelayableOutput(
            requestBody,
            claimed.record.attemptCount,
            MEMORY_ITEM_REQUIRES_SEARCH_MEMORY_RESULT_OUTPUT,
            false,
            traceOptions,
          );
        }

        const result = await getMemoryItemForTool({
          memoryKind: parsedArguments.memoryKind,
          memoryId: parsedArguments.memoryId,
        });

        if (!result) {
          return persistRelayableOutput(
            requestBody,
            claimed.record.attemptCount,
            RETRIEVAL_FAILED_OUTPUT,
            false,
            traceOptions,
          );
        }

        return persistRelayableOutput(
          requestBody,
          claimed.record.attemptCount,
          result,
          true,
          traceOptions,
        );
      } catch (error) {
        console.error("briefing.tool.get_memory_item_failed", {
          briefingSessionId: requestBody.briefingSessionId,
          functionCallId: requestBody.functionCallId,
          digestId: session.digestId,
          error: error instanceof Error ? error.message : String(error),
        });

        return persistRelayableOutput(
          requestBody,
          claimed.record.attemptCount,
          RETRIEVAL_FAILED_OUTPUT,
          false,
          traceOptions,
        );
      }
    }

    if (requestBody.toolName === "list_archive_items") {
      const parsedArguments = parseListArchiveItemsArguments(requestBody.arguments);
      if (!parsedArguments) {
        await failClaimedCall(
          requestBody.briefingSessionId,
          requestBody.functionCallId,
          requestBody.toolName,
          claimed.record.attemptCount,
          "invalid_arguments",
        );
        return jsonError("invalid_arguments", 400);
      }

      try {
        const result = await listArchiveItemsForTool(parsedArguments);

        return persistRelayableOutput(
          requestBody,
          claimed.record.attemptCount,
          result,
          true,
          traceOptions,
        );
      } catch (error) {
        console.error("briefing.tool.list_archive_items_failed", {
          briefingSessionId: requestBody.briefingSessionId,
          functionCallId: requestBody.functionCallId,
          digestId: session.digestId,
          error: error instanceof Error ? error.message : String(error),
        });

        return persistRelayableOutput(
          requestBody,
          claimed.record.attemptCount,
          RETRIEVAL_FAILED_OUTPUT,
          false,
          traceOptions,
        );
      }
    }

    const parsedArguments = parseSearchArchiveArguments(requestBody.arguments);
    if (!parsedArguments) {
      await failClaimedCall(
        requestBody.briefingSessionId,
        requestBody.functionCallId,
        requestBody.toolName,
        claimed.record.attemptCount,
        "invalid_arguments",
      );
      return jsonError("invalid_arguments", 400);
    }

    try {
      const results = await searchArchiveForTool({
        query: parsedArguments.query,
        source: parsedArguments.source,
        after: parsedArguments.after,
        before: parsedArguments.before,
        limit: parsedArguments.limit,
      });

      return persistRelayableOutput(
        requestBody,
        claimed.record.attemptCount,
        {
          results: normalizeArchiveResults(results),
        },
        true,
        traceOptions,
      );
    } catch (error) {
      console.error("briefing.tool.search_archive_failed", {
        briefingSessionId: requestBody.briefingSessionId,
        functionCallId: requestBody.functionCallId,
        digestId: session.digestId,
        error: error instanceof Error ? error.message : String(error),
      });

      return persistRelayableOutput(
        requestBody,
        claimed.record.attemptCount,
        RETRIEVAL_FAILED_OUTPUT,
        false,
        traceOptions,
      );
    }
  } catch (error) {
    if (error instanceof MissingClientIpError) {
      return jsonError("missing_client_ip", 400);
    }

    console.error("briefing.tool.failed", {
      briefingSessionId: requestBody?.briefingSessionId ?? null,
      functionCallId: requestBody?.functionCallId ?? null,
      error: error instanceof Error ? error.message : String(error),
    });
    return jsonError("briefing_tool_failed", 500);
  }
}
