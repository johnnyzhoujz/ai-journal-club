import {
  isBriefingObservabilityEnabled,
  recordBriefingTraceEvent,
  recordBriefingTraceFlag,
  type BriefingTraceFlagAction,
  type BriefingTraceFlagSeverity,
} from "@/lib/briefing-observability";
import { getBriefingSession } from "@/lib/briefing-session";
import {
  DEFAULT_BRIEFING_RATE_LIMITS,
  MissingClientIpError,
  consumeRateLimit,
  deriveClientIpInfo,
} from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TRACE_BODY_CHARS = 64_000;
const MAX_TRACE_EVENTS = 50;
const MAX_TRACE_FLAGS = 50;
const TRACE_EVENT_FIELDS = new Set([
  "eventType",
  "responseId",
  "itemId",
  "functionCallId",
  "toolName",
  "role",
  "textExcerpt",
  "argumentsJson",
  "resultSummaryJson",
  "latencyMs",
]);
const TRACE_FLAG_FIELDS = new Set([
  "ruleId",
  "severity",
  "action",
  "toolName",
  "originalJson",
  "correctedJson",
  "detailsJson",
]);
const TRACE_ROLES = new Set(["assistant", "user", "tool"]);
const FLAG_SEVERITIES = new Set<BriefingTraceFlagSeverity>([
  "info",
  "warning",
  "error",
]);
const FLAG_ACTIONS = new Set<BriefingTraceFlagAction>([
  "logged",
  "nudged",
  "normalized_args",
  "blocked_tool",
]);

type TraceEventInput = {
  eventType: string;
  responseId?: string | null;
  itemId?: string | null;
  functionCallId?: string | null;
  toolName?: string | null;
  role?: "assistant" | "user" | "tool" | null;
  textExcerpt?: string | null;
  argumentsJson?: unknown;
  resultSummaryJson?: unknown;
  latencyMs?: number | null;
};

type TraceFlagInput = {
  ruleId: string;
  severity: BriefingTraceFlagSeverity;
  action: BriefingTraceFlagAction;
  toolName?: string | null;
  originalJson?: unknown;
  correctedJson?: unknown;
  detailsJson?: unknown;
};

type TraceRequestBody = {
  briefingSessionId: string;
  events: TraceEventInput[];
  flags: TraceFlagInput[];
};

function jsonError(error: string, status = 500) {
  return Response.json({ error }, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readOptionalString(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  return typeof value === "string" ? value : undefined;
}

function hasOnlyKnownFields(value: Record<string, unknown>, fields: Set<string>) {
  return Object.keys(value).every((key) => fields.has(key));
}

function parseTraceEvent(value: unknown): TraceEventInput | null {
  if (!isRecord(value) || !hasOnlyKnownFields(value, TRACE_EVENT_FIELDS)) {
    return null;
  }

  if (typeof value.eventType !== "string" || !value.eventType.trim()) {
    return null;
  }

  const responseId = "responseId" in value ? readOptionalString(value.responseId) : null;
  const itemId = "itemId" in value ? readOptionalString(value.itemId) : null;
  const functionCallId =
    "functionCallId" in value ? readOptionalString(value.functionCallId) : null;
  const toolName = "toolName" in value ? readOptionalString(value.toolName) : null;
  const textExcerpt =
    "textExcerpt" in value ? readOptionalString(value.textExcerpt) : null;
  if (
    responseId === undefined ||
    itemId === undefined ||
    functionCallId === undefined ||
    toolName === undefined ||
    textExcerpt === undefined
  ) {
    return null;
  }

  const role = "role" in value ? readOptionalString(value.role) : null;
  if (role === undefined || (role !== null && !TRACE_ROLES.has(role))) {
    return null;
  }

  const latencyMs =
    value.latencyMs === undefined || value.latencyMs === null
      ? null
      : Number.isInteger(value.latencyMs) && (value.latencyMs as number) >= 0
        ? (value.latencyMs as number)
        : undefined;
  if (latencyMs === undefined) {
    return null;
  }

  return {
    eventType: value.eventType.trim(),
    responseId,
    itemId,
    functionCallId,
    toolName,
    role: role as TraceEventInput["role"],
    textExcerpt,
    argumentsJson: value.argumentsJson,
    resultSummaryJson: value.resultSummaryJson,
    latencyMs,
  };
}

function parseTraceFlag(value: unknown): TraceFlagInput | null {
  if (!isRecord(value) || !hasOnlyKnownFields(value, TRACE_FLAG_FIELDS)) {
    return null;
  }

  if (typeof value.ruleId !== "string" || !value.ruleId.trim()) {
    return null;
  }
  if (
    typeof value.severity !== "string" ||
    !FLAG_SEVERITIES.has(value.severity as BriefingTraceFlagSeverity)
  ) {
    return null;
  }
  if (
    typeof value.action !== "string" ||
    !FLAG_ACTIONS.has(value.action as BriefingTraceFlagAction)
  ) {
    return null;
  }

  const toolName = "toolName" in value ? readOptionalString(value.toolName) : null;
  if (toolName === undefined) {
    return null;
  }

  return {
    ruleId: value.ruleId.trim(),
    severity: value.severity as BriefingTraceFlagSeverity,
    action: value.action as BriefingTraceFlagAction,
    toolName,
    originalJson: value.originalJson,
    correctedJson: value.correctedJson,
    detailsJson: value.detailsJson,
  };
}

function parseTraceRequestBody(value: unknown): TraceRequestBody | null {
  if (!isRecord(value)) {
    return null;
  }

  if (
    typeof value.briefingSessionId !== "string" ||
    !value.briefingSessionId.trim() ||
    !Array.isArray(value.events) ||
    !Array.isArray(value.flags) ||
    value.events.length > MAX_TRACE_EVENTS ||
    value.flags.length > MAX_TRACE_FLAGS
  ) {
    return null;
  }

  const events = value.events.map(parseTraceEvent);
  const flags = value.flags.map(parseTraceFlag);
  if (events.some((event) => event === null) || flags.some((flag) => flag === null)) {
    return null;
  }

  return {
    briefingSessionId: value.briefingSessionId,
    events: events as TraceEventInput[],
    flags: flags as TraceFlagInput[],
  };
}

export async function POST(request: Request) {
  try {
    const rawText = await request.text();
    if (rawText.length > MAX_TRACE_BODY_CHARS) {
      return jsonError("payload_too_large", 413);
    }

    let rawBody: unknown;
    try {
      rawBody = JSON.parse(rawText) as unknown;
    } catch {
      return jsonError("invalid_request_body", 400);
    }

    const requestBody = parseTraceRequestBody(rawBody);
    if (!requestBody) {
      return jsonError("invalid_request_body", 400);
    }

    if (!isBriefingObservabilityEnabled()) {
      return Response.json({
        ok: true,
        disabled: true,
        acceptedEvents: 0,
        acceptedFlags: 0,
      });
    }

    const { clientIpHash } = deriveClientIpInfo(request.headers);
    const rateLimit = await consumeRateLimit({
      headers: request.headers,
      routeKey: "briefing/trace",
      limit: DEFAULT_BRIEFING_RATE_LIMITS.trace,
    });

    if (!rateLimit.allowed) {
      return jsonError("rate_limited", 429);
    }

    const session = await getBriefingSession(requestBody.briefingSessionId);
    if (!session || session.closedAt || session.clientIpHash !== clientIpHash) {
      return jsonError("invalid_session", 404);
    }

    if (Date.parse(session.expiresAt) <= Date.now()) {
      return jsonError("session_expired", 410);
    }

    for (const event of requestBody.events) {
      await recordBriefingTraceEvent({
        briefingSessionId: requestBody.briefingSessionId,
        eventType: event.eventType,
        source: "client",
        responseId: event.responseId,
        itemId: event.itemId,
        functionCallId: event.functionCallId,
        toolName: event.toolName,
        role: event.role,
        textExcerpt: event.textExcerpt,
        argumentsJson: event.argumentsJson,
        resultSummaryJson: event.resultSummaryJson,
        latencyMs: event.latencyMs,
      });
    }

    for (const flag of requestBody.flags) {
      await recordBriefingTraceFlag({
        briefingSessionId: requestBody.briefingSessionId,
        ruleId: flag.ruleId,
        severity: flag.severity,
        action: flag.action,
        toolName: flag.toolName,
        originalJson: flag.originalJson,
        correctedJson: flag.correctedJson,
        detailsJson: flag.detailsJson,
      });
    }

    return Response.json({
      ok: true,
      acceptedEvents: requestBody.events.length,
      acceptedFlags: requestBody.flags.length,
    });
  } catch (error) {
    if (error instanceof MissingClientIpError) {
      return jsonError("missing_client_ip", 400);
    }

    console.error("briefing.trace.failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return jsonError("briefing_trace_failed", 500);
  }
}
