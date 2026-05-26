import { sql } from "@/lib/db";
import type { BriefingToolName } from "@/lib/briefing-session";

export const TRACE_TEXT_EXCERPT_MAX_CHARS = 500;
export const TRACE_RESULT_SNIPPET_MAX_CHARS = 600;
export const TRACE_RESULT_IDS_MAX = 5;

export type BriefingTraceEventSource = "client" | "server";
export type BriefingTraceEventRole = "assistant" | "user" | "tool";
export type BriefingTraceFlagSeverity = "info" | "warning" | "error";
export type BriefingTraceFlagAction =
  | "logged"
  | "nudged"
  | "normalized_args"
  | "blocked_tool";

export interface RecordBriefingTraceEventOptions {
  briefingSessionId: string;
  eventType: string;
  source: BriefingTraceEventSource;
  responseId?: string | null;
  itemId?: string | null;
  functionCallId?: string | null;
  toolName?: BriefingToolName | string | null;
  role?: BriefingTraceEventRole | null;
  textExcerpt?: string | null;
  argumentsJson?: unknown;
  resultSummaryJson?: unknown;
  latencyMs?: number | null;
}

export interface RecordBriefingTraceFlagOptions {
  briefingSessionId: string;
  ruleId: string;
  severity: BriefingTraceFlagSeverity;
  action: BriefingTraceFlagAction;
  eventId?: number | null;
  toolName?: BriefingToolName | string | null;
  originalJson?: unknown;
  correctedJson?: unknown;
  detailsJson?: unknown;
}

type JsonishRecord = Record<string, unknown>;

export function isBriefingObservabilityEnabled(
  env: { BRIEFING_OBSERVABILITY_ENABLED?: string } = process.env as {
    BRIEFING_OBSERVABILITY_ENABLED?: string;
  },
): boolean {
  return env.BRIEFING_OBSERVABILITY_ENABLED === "true";
}

function boundText(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return normalized.slice(0, maxChars).trim();
}

function toJsonParam(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }

  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : serialized;
  } catch {
    return JSON.stringify({
      serialization_error: true,
    });
  }
}

function isRecord(value: unknown): value is JsonishRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readSnippet(value: JsonishRecord): string | null {
  for (const key of ["snippet", "content_excerpt", "text_excerpt", "excerpt"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return boundText(candidate, TRACE_RESULT_SNIPPET_MAX_CHARS);
    }
  }
  return null;
}

function summarizeResultItem(value: unknown): JsonishRecord {
  if (!isRecord(value)) {
    return {
      value_excerpt: boundText(String(value), TRACE_RESULT_SNIPPET_MAX_CHARS),
    };
  }

  const summary: JsonishRecord = {};
  for (const key of [
    "id",
    "kind",
    "feed_item_id",
    "source_type",
    "title",
    "author_name",
    "published_at",
  ]) {
    const candidate = value[key];
    if (
      typeof candidate === "string" ||
      typeof candidate === "number" ||
      candidate === null
    ) {
      summary[key] = candidate;
    }
  }

  const snippet = readSnippet(value);
  if (snippet) {
    summary.snippet = snippet;
  }

  return summary;
}

export function summarizeToolOutputForTrace(output: unknown): JsonishRecord {
  if (!isRecord(output)) {
    return {
      value_excerpt:
        typeof output === "string"
          ? boundText(output, TRACE_RESULT_SNIPPET_MAX_CHARS)
          : boundText(JSON.stringify(output), TRACE_RESULT_SNIPPET_MAX_CHARS),
    };
  }

  const summary: JsonishRecord = {};

  if (typeof output.error === "string") {
    summary.error = output.error;
  }
  if (typeof output.retryable === "boolean") {
    summary.retryable = output.retryable;
  }
  if (typeof output.total_count === "number") {
    summary.total_count = output.total_count;
  }
  if (typeof output.returned_count === "number") {
    summary.returned_count = output.returned_count;
  }
  if (typeof output.has_more === "boolean") {
    summary.has_more = output.has_more;
  }

  if (Array.isArray(output.results)) {
    summary.result_count = output.results.length;
    summary.result_ids = output.results.slice(0, TRACE_RESULT_IDS_MAX).map((item) => {
      if (!isRecord(item)) {
        return null;
      }
      return item.id ?? item.feed_item_id ?? null;
    });
    summary.results = output.results
      .slice(0, TRACE_RESULT_IDS_MAX)
      .map((item) => summarizeResultItem(item));
    return summary;
  }

  for (const key of [
    "id",
    "kind",
    "feed_item_id",
    "source_type",
    "title",
    "author_name",
    "published_at",
  ]) {
    const candidate = output[key];
    if (
      typeof candidate === "string" ||
      typeof candidate === "number" ||
      candidate === null
    ) {
      summary[key] = candidate;
    }
  }

  const snippet = readSnippet(output);
  if (snippet) {
    summary.snippet = snippet;
  }

  return Object.keys(summary).length > 0
    ? summary
    : {
        value_excerpt: boundText(
          JSON.stringify(output),
          TRACE_RESULT_SNIPPET_MAX_CHARS,
        ),
      };
}

export async function recordBriefingTraceEvent(
  options: RecordBriefingTraceEventOptions,
): Promise<number | null> {
  if (!isBriefingObservabilityEnabled()) {
    return null;
  }

  try {
    const rows = await sql`
      INSERT INTO briefing_trace_events (
        briefing_session_id,
        event_type,
        source,
        response_id,
        item_id,
        function_call_id,
        tool_name,
        role,
        text_excerpt,
        arguments_json,
        result_summary_json,
        latency_ms
      )
      VALUES (
        ${options.briefingSessionId},
        ${options.eventType},
        ${options.source},
        ${options.responseId ?? null},
        ${options.itemId ?? null},
        ${options.functionCallId ?? null},
        ${options.toolName ?? null},
        ${options.role ?? null},
        ${
          typeof options.textExcerpt === "string"
            ? boundText(options.textExcerpt, TRACE_TEXT_EXCERPT_MAX_CHARS)
            : null
        },
        ${toJsonParam(options.argumentsJson)}::jsonb,
        ${toJsonParam(options.resultSummaryJson)}::jsonb,
        ${options.latencyMs ?? null}
      )
      RETURNING id
    `;

    return Number((rows[0] as { id?: number | string } | undefined)?.id ?? null) || null;
  } catch (error) {
    console.error("briefing.observability.trace_event_failed", {
      briefingSessionId: options.briefingSessionId,
      eventType: options.eventType,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function recordBriefingTraceFlag(
  options: RecordBriefingTraceFlagOptions,
): Promise<void> {
  if (!isBriefingObservabilityEnabled()) {
    return;
  }

  try {
    await sql`
      INSERT INTO briefing_trace_flags (
        briefing_session_id,
        rule_id,
        severity,
        action,
        event_id,
        tool_name,
        original_json,
        corrected_json,
        details_json
      )
      VALUES (
        ${options.briefingSessionId},
        ${options.ruleId},
        ${options.severity},
        ${options.action},
        ${options.eventId ?? null},
        ${options.toolName ?? null},
        ${toJsonParam(options.originalJson)}::jsonb,
        ${toJsonParam(options.correctedJson)}::jsonb,
        ${toJsonParam(options.detailsJson)}::jsonb
      )
    `;
  } catch (error) {
    console.error("briefing.observability.trace_flag_failed", {
      briefingSessionId: options.briefingSessionId,
      ruleId: options.ruleId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
