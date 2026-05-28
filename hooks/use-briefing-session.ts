"use client";

import { startTransition, useCallback, useEffect, useRef, useState } from "react";
import {
  applyBriefingRuntimeToolCall,
  applyBriefingRuntimeToolResult,
} from "@/lib/briefing-runtime-loop";
import {
  type BriefingRuntimeEvalFlag,
  type BriefingRuntimeToolCall,
  type BriefingRuntimeToolRecord,
} from "@/lib/briefing-runtime-evals";

export type BriefingStatus = "idle" | "connecting" | "active" | "error" | "ended";

export type BriefingTranscriptItem = {
  id: string;
  role: "assistant" | "user";
  text: string;
  status: "streaming" | "complete" | "failed";
  itemId: string | null;
  previousItemId: string | null;
};

export type BriefingUiError =
  | {
      code: string;
      message: string;
    }
  | null;

export type UseBriefingSessionOptions = {
  digestId: number;
};

export type UseBriefingSessionResult = {
  status: BriefingStatus;
  transcriptItems: BriefingTranscriptItem[];
  isAiSpeaking: boolean;
  isUserSpeaking: boolean;
  isMuted: boolean;
  elapsedSeconds: number;
  error: BriefingUiError;
  briefingSessionId: string | null;
  canSendText: boolean;
  remoteStream: MediaStream | null;
  start: () => Promise<void>;
  end: () => Promise<void>;
  toggleMute: () => void;
  sendText: (input: string) => Promise<void>;
  stopCurrentResponse: () => void;
  clearError: () => void;
};

type CallRouteSuccess = {
  answerSdp: string;
  briefingSessionId: string;
  recommendedEndAt: string;
  observabilityEnabled: boolean;
  compaction: RealtimeCompactionConfig;
};

type RealtimeCompactionConfig = {
  enabled: boolean;
  triggerInputTokens: number;
  keepRecentItemCount: number;
  minDeleteItemCount: number;
};

type ToolRouteSuccess = {
  ok: true;
  functionCallId: string;
  output: unknown;
};

type TranscriptNode = BriefingTranscriptItem & {
  sortOrder: number;
};

type ItemMetadata = {
  previousItemId: string | null;
  sortOrder: number;
};

type ConversationRecord = {
  itemId: string;
  type: string | null;
  role: string | null;
  text: string;
  responseId: string | null;
  functionCallId: string | null;
  createdAt: number;
  serverDeleted: boolean;
  compactable: boolean;
};

type PendingCompaction = {
  summaryEventId: string;
  summaryText: string;
  deleteItemIds: string[];
  timeoutId: number;
};

type ToolCallState = {
  functionCallId: string;
  itemId: string | null;
  responseId: string | null;
  toolName: BriefingToolName | null;
  argumentsText: string;
  argumentsComplete: boolean;
  responseStatus: string | null;
  responseCompleted: boolean;
  matchedResponseOutput: boolean;
  executionStarted: boolean;
  pendingRelay: {
    output: unknown;
    requestAssistantResponse: boolean;
  } | null;
  relaySent: boolean;
};

type SessionRuntime = {
  runId: number;
  peerConnection: RTCPeerConnection;
  dataChannel: RTCDataChannel;
  localStream: MediaStream;
  remoteStream: MediaStream;
  remoteAudio: HTMLAudioElement;
  closedByClient: boolean;
  initialResponseSent: boolean;
};

type BriefingToolName =
  | "get_digest_item"
  | "search_archive"
  | "list_archive_items"
  | "search_memory"
  | "get_memory_item"
  | "wait_for_user";

type ClientTraceEvent = {
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

type ClientTraceFlag = BriefingRuntimeEvalFlag;

const RELAYABLE_TOOL_FAILURE = {
  error: "retrieval_failed",
  retryable: true,
} as const;

const MICROPHONE_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: false,
};
const DEFAULT_COMPACTION_CONFIG: RealtimeCompactionConfig = {
  enabled: false,
  triggerInputTokens: 24_000,
  keepRecentItemCount: 8,
  minDeleteItemCount: 6,
};
const COMPACTION_SUMMARY_PREFIX =
  "Summary of earlier briefing conversation for context:";
const COMPACTION_SUMMARY_TIMEOUT_MS = 8_000;

function isToolCallReadyForRelay(callState: ToolCallState): boolean {
  return (
    callState.responseCompleted &&
    callState.matchedResponseOutput &&
    callState.responseStatus === "completed"
  );
}

const STARTUP_ERROR_CODES = new Set([
  "stale_digest",
  "too_many_active_sessions",
  "rate_limited",
  "missing_client_ip",
]);

const TOOL_REQUEST_ERROR_CODES = new Set([
  "rate_limited",
  "missing_client_ip",
  "session_expired",
  "invalid_session",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readNullableString(value: unknown): string | null {
  return value === null ? null : readString(value);
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readPositiveInteger(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) > 0
    ? (value as number)
    : null;
}

function readJsonErrorCode(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }

  return readString(value.error);
}

function parseBriefingToolName(value: unknown): BriefingToolName | null {
  if (
    value === "get_digest_item" ||
    value === "search_archive" ||
    value === "list_archive_items" ||
    value === "search_memory" ||
    value === "get_memory_item" ||
    value === "wait_for_user"
  ) {
    return value;
  }

  return null;
}

function buildUiError(code: string): NonNullable<BriefingUiError> {
  switch (code) {
    case "stale_digest":
      return {
        code,
        message: "The latest digest changed. Refresh the dashboard and start the briefing again.",
      };
    case "too_many_active_sessions":
      return {
        code,
        message: "Too many active briefing sessions are already open. End one and try again.",
      };
    case "rate_limited":
      return {
        code,
        message: "Briefing requests are temporarily rate limited. Try again in a moment.",
      };
    case "missing_client_ip":
      return {
        code,
        message: "The server could not verify the client IP for this briefing request.",
      };
    case "session_expired":
      return {
        code,
        message: "This briefing session expired. Start again to continue.",
      };
    case "microphone_denied":
      return {
        code,
        message: "Microphone access is required to start the briefing.",
      };
    case "audio_playback_failed":
      return {
        code,
        message: "Audio playback could not start. Try Start Briefing again or switch to Text Deep Dive.",
      };
    case "transport_lost":
      return {
        code,
        message: "The live briefing connection was lost. Start again to continue.",
      };
    case "connection_failed":
    default:
      return {
        code,
        message: "The briefing connection could not be started or continued. Try again.",
      };
  }
}

function isMicrophoneDeniedError(error: unknown) {
  return (
    error instanceof DOMException &&
    (error.name === "NotAllowedError" || error.name === "SecurityError")
  );
}

function parseCallRouteSuccess(value: unknown): CallRouteSuccess | null {
  if (!isRecord(value)) {
    return null;
  }

  const answerSdp = readString(value.answerSdp);
  const briefingSessionId = readString(value.briefingSessionId);
  const recommendedEndAt = readString(value.recommendedEndAt);

  if (!answerSdp || !briefingSessionId || !recommendedEndAt) {
    return null;
  }

  return {
    answerSdp,
    briefingSessionId,
    recommendedEndAt,
    observabilityEnabled: value.observabilityEnabled === true,
    compaction: parseRealtimeCompactionConfig(value.compaction),
  };
}

function parseRealtimeCompactionConfig(value: unknown): RealtimeCompactionConfig {
  if (!isRecord(value) || value.enabled !== true) {
    return DEFAULT_COMPACTION_CONFIG;
  }

  return {
    enabled: true,
    triggerInputTokens:
      readPositiveInteger(value.triggerInputTokens) ??
      DEFAULT_COMPACTION_CONFIG.triggerInputTokens,
    keepRecentItemCount:
      readPositiveInteger(value.keepRecentItemCount) ??
      DEFAULT_COMPACTION_CONFIG.keepRecentItemCount,
    minDeleteItemCount:
      readPositiveInteger(value.minDeleteItemCount) ??
      DEFAULT_COMPACTION_CONFIG.minDeleteItemCount,
  };
}

function parseToolRouteSuccess(value: unknown): ToolRouteSuccess | null {
  if (!isRecord(value) || value.ok !== true) {
    return null;
  }

  const functionCallId = readString(value.functionCallId);
  if (!functionCallId) {
    return null;
  }

  return {
    ok: true,
    functionCallId,
    output: value.output,
  };
}

function parseRealtimePayload(data: unknown): Record<string, unknown> | null {
  if (typeof data !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(data) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseToolArguments(
  toolName: BriefingToolName | null,
  argumentsText: string,
): Record<string, unknown> | null {
  if (!toolName || !argumentsText.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(argumentsText) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractContentText(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((item) => {
      if (!isRecord(item)) {
        return "";
      }

      const text = readString(item.text);
      if (text) {
        return text;
      }

      return readString(item.transcript) ?? "";
    })
    .filter(Boolean)
    .join("");
}

function extractRealtimeUsage(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }

  const summary: Record<string, unknown> = {};
  for (const key of ["total_tokens", "input_tokens", "output_tokens"]) {
    const numberValue = readNumber(value[key]);
    if (numberValue !== null) {
      summary[key] = numberValue;
    }
  }

  for (const key of ["input_token_details", "output_token_details"]) {
    if (isRecord(value[key])) {
      summary[key] = value[key];
    }
  }

  return Object.keys(summary).length > 0 ? summary : null;
}

function extractTranscriptionUsage(value: unknown): Record<string, unknown> | null {
  return extractRealtimeUsage(value);
}

function extractRealtimeInputTokens(value: unknown): number | null {
  if (!isRecord(value)) {
    return null;
  }

  return readNumber(value.input_tokens);
}

function extractRealtimePhaseSummary(output: unknown): Record<string, unknown> | null {
  if (!Array.isArray(output)) {
    return null;
  }

  let commentaryCount = 0;
  let finalAnswerCount = 0;
  let unknownPhaseCount = 0;
  let firstPhase: string | null = null;
  const transcriptCharCountByPhase: Record<string, number> = {
    commentary: 0,
    final_answer: 0,
    unknown: 0,
  };

  for (const item of output) {
    if (!isRecord(item)) {
      unknownPhaseCount += 1;
      continue;
    }

    const rawPhase = readString(item.phase);
    const phase =
      rawPhase === "commentary" || rawPhase === "final_answer"
        ? rawPhase
        : "unknown";
    firstPhase ??= phase;

    if (phase === "commentary") {
      commentaryCount += 1;
    } else if (phase === "final_answer") {
      finalAnswerCount += 1;
    } else {
      unknownPhaseCount += 1;
    }

    const contentText = extractContentText(item.content);
    transcriptCharCountByPhase[phase] =
      (transcriptCharCountByPhase[phase] ?? 0) + contentText.length;
  }

  return {
    commentary_count: commentaryCount,
    final_answer_count: finalAnswerCount,
    unknown_phase_count: unknownPhaseCount,
    first_phase: firstPhase,
    output_count: output.length,
    transcript_char_count_by_phase: transcriptCharCountByPhase,
  };
}

function extractFunctionCallOutputs(
  response: Record<string, unknown>,
): Array<{
  functionCallId: string;
  itemId: string | null;
  toolName: BriefingToolName | null;
  argumentsText: string | null;
}> {
  if (!Array.isArray(response.output)) {
    return [];
  }

  const outputs: Array<{
    functionCallId: string;
    itemId: string | null;
    toolName: BriefingToolName | null;
    argumentsText: string | null;
  }> = [];

  for (const item of response.output) {
    if (!isRecord(item) || readString(item.type) !== "function_call") {
      continue;
    }

    const functionCallId = readString(item.call_id);
    if (!functionCallId) {
      continue;
    }

    const toolName = parseBriefingToolName(item.name);
    outputs.push({
      functionCallId,
      itemId: readNullableString(item.id),
      toolName,
      argumentsText: readString(item.arguments),
    });
  }

  return outputs;
}

function resolveVisiblePreviousItemId(
  itemId: string | null,
  previousItemId: string | null,
  visibleItemIds: Set<string>,
  itemMetadata: Map<string, ItemMetadata>,
) {
  if (!itemId) {
    return null;
  }

  let current = previousItemId ?? itemMetadata.get(itemId)?.previousItemId ?? null;
  const seen = new Set<string>();

  while (current) {
    if (visibleItemIds.has(current)) {
      return current;
    }

    if (seen.has(current)) {
      return null;
    }

    seen.add(current);
    current = itemMetadata.get(current)?.previousItemId ?? null;
  }

  return null;
}

function buildOrderedTranscriptItems(
  transcriptNodes: Map<string, TranscriptNode>,
  itemMetadata: Map<string, ItemMetadata>,
) {
  const nodes = [...transcriptNodes.values()];
  if (nodes.length === 0) {
    return [];
  }

  const visibleItemIds = new Set(
    nodes
      .map((node) => node.itemId)
      .filter((itemId): itemId is string => Boolean(itemId)),
  );
  const childrenByParent = new Map<string | null, TranscriptNode[]>();

  for (const node of nodes) {
    const parentId = resolveVisiblePreviousItemId(
      node.itemId,
      node.previousItemId,
      visibleItemIds,
      itemMetadata,
    );
    const bucket = childrenByParent.get(parentId) ?? [];
    bucket.push(node);
    childrenByParent.set(parentId, bucket);
  }

  const sortNodes = (unsorted: TranscriptNode[]) =>
    [...unsorted].sort((left, right) => {
      if (left.sortOrder !== right.sortOrder) {
        return left.sortOrder - right.sortOrder;
      }

      return left.id.localeCompare(right.id);
    });

  const ordered: TranscriptNode[] = [];
  const visited = new Set<string>();

  const visit = (parentId: string | null) => {
    for (const node of sortNodes(childrenByParent.get(parentId) ?? [])) {
      if (visited.has(node.id)) {
        continue;
      }

      visited.add(node.id);
      ordered.push(node);
      if (node.itemId) {
        visit(node.itemId);
      }
    }
  };

  visit(null);

  for (const node of sortNodes(nodes)) {
    if (visited.has(node.id)) {
      continue;
    }

    visited.add(node.id);
    ordered.push(node);
    if (node.itemId) {
      visit(node.itemId);
    }
  }

  return ordered.map((item) => ({
    id: item.id,
    role: item.role,
    text: item.text,
    status: item.status,
    itemId: item.itemId,
    previousItemId: item.previousItemId,
  }));
}

function createTranscriptNode(
  id: string,
  role: BriefingTranscriptItem["role"],
  itemId: string | null,
  previousItemId: string | null,
  sortOrder: number,
) {
  return {
    id,
    role,
    text: "",
    status: "streaming",
    itemId,
    previousItemId,
    sortOrder,
  } satisfies TranscriptNode;
}

function createRemoteAudioElement(remoteStream: MediaStream) {
  const audio = new Audio();
  audio.autoplay = true;
  audio.setAttribute("playsinline", "true");
  audio.srcObject = remoteStream;
  return audio;
}

function stopMediaStream(stream: MediaStream | null) {
  if (!stream) {
    return;
  }

  for (const track of stream.getTracks()) {
    track.stop();
  }
}

function detachAudioElement(audio: HTMLAudioElement | null) {
  if (!audio) {
    return;
  }

  audio.pause();
  audio.srcObject = null;
}

async function readJsonSafely(response: Response) {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

function stringifyFunctionCallOutput(output: unknown) {
  return typeof output === "string" ? output : JSON.stringify(output);
}

function normalizeTraceText(value: string, maxChars = 500) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxChars
    ? normalized.slice(0, maxChars).trim()
    : normalized;
}

function summarizeConversationText(value: string, maxChars = 220) {
  return normalizeTraceText(value, maxChars);
}

function conversationRecordLabel(record: ConversationRecord) {
  if (record.role === "user") {
    return "User";
  }
  if (record.role === "assistant") {
    return "Assistant";
  }
  if (record.type === "function_call") {
    return `Tool call${record.functionCallId ? ` ${record.functionCallId}` : ""}`;
  }
  if (record.type === "function_call_output") {
    return `Tool result${record.functionCallId ? ` ${record.functionCallId}` : ""}`;
  }
  return record.type ?? "Item";
}

function buildConversationCompactionSummary(records: ConversationRecord[]) {
  const lines = records
    .filter((record) => record.text.trim() || record.type === "function_call")
    .slice(-18)
    .map((record) => {
      const text = record.text.trim()
        ? summarizeConversationText(record.text)
        : "Completed.";
      return `- ${conversationRecordLabel(record)}: ${text}`;
    });

  return [
    COMPACTION_SUMMARY_PREFIX,
    ...(lines.length > 0
      ? lines
      : ["- Earlier turns contained no durable user-facing details."]),
  ].join("\n");
}

function summarizeClientToolOutput(output: unknown) {
  if (!isRecord(output)) {
    return {
      value_excerpt: normalizeTraceText(String(output), 600),
    };
  }

  const summary: Record<string, unknown> = {};
  if (typeof output.error === "string") {
    summary.error = output.error;
  }
  if (typeof output.retryable === "boolean") {
    summary.retryable = output.retryable;
  }
  if (Array.isArray(output.results)) {
    summary.result_count = output.results.length;
    summary.result_ids = output.results.slice(0, 5).map((item) => {
      if (!isRecord(item)) {
        return null;
      }
      return item.id ?? item.feed_item_id ?? null;
    });
    summary.results = output.results.slice(0, 5).map((item) => {
      if (!isRecord(item)) {
        return {
          value_excerpt: normalizeTraceText(String(item), 600),
        };
      }
      return {
        id: item.id ?? null,
        feed_item_id: item.feed_item_id ?? null,
        source_type: item.source_type ?? null,
        title: item.title ?? null,
        snippet:
          typeof item.snippet === "string"
            ? normalizeTraceText(item.snippet, 600)
            : null,
      };
    });
    return summary;
  }

  for (const key of ["id", "kind", "feed_item_id", "source_type", "title"]) {
    if (key in output) {
      summary[key] = output[key];
    }
  }
  for (const key of ["snippet", "content_excerpt", "text_excerpt"]) {
    if (typeof output[key] === "string") {
      summary.snippet = normalizeTraceText(output[key], 600);
      break;
    }
  }

  return summary;
}

function buildEndRouteRequestInit(sessionId: string): RequestInit {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      briefingSessionId: sessionId,
    }),
    keepalive: true,
  };
}

export function useBriefingSession({
  digestId,
}: UseBriefingSessionOptions): UseBriefingSessionResult {
  const [status, setStatus] = useState<BriefingStatus>("idle");
  const [transcriptItems, setTranscriptItems] = useState<BriefingTranscriptItem[]>([]);
  const [isAiSpeaking, setIsAiSpeaking] = useState(false);
  const [isUserSpeaking, setIsUserSpeaking] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [error, setError] = useState<BriefingUiError>(null);
  const [briefingSessionId, setBriefingSessionId] = useState<string | null>(null);
  const [canSendText, setCanSendText] = useState(false);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [activeStartedAt, setActiveStartedAt] = useState<number | null>(null);

  const statusRef = useRef<BriefingStatus>("idle");
  const isMutedRef = useRef(true);
  const briefingSessionIdRef = useRef<string | null>(null);
  const runtimeRef = useRef<SessionRuntime | null>(null);
  const runIdRef = useRef(0);
  const nextSortOrderRef = useRef(0);
  const nextSyntheticIdRef = useRef(0);
  const itemMetadataRef = useRef(new Map<string, ItemMetadata>());
  const transcriptNodesRef = useRef(new Map<string, TranscriptNode>());
  const functionCallsRef = useRef(new Map<string, ToolCallState>());
  const responseInFlightRef = useRef(false);
  const isMountedRef = useRef(true);
  const observabilityEnabledRef = useRef(false);
  const traceEventsRef = useRef<ClientTraceEvent[]>([]);
  const traceFlagsRef = useRef<ClientTraceFlag[]>([]);
  const traceFlushTimerRef = useRef<number | null>(null);
  const currentUserTurnRef = useRef("");
  const assistantTextByResponseRef = useRef(new Map<string, string>());
  const previousToolCallsRef = useRef<BriefingRuntimeToolRecord[]>([]);
  const responseCreatedAtRef = useRef(new Map<string, number>());
  const responseFirstAudioTranscriptTracedRef = useRef(new Set<string>());
  const compactionConfigRef = useRef<RealtimeCompactionConfig>(
    DEFAULT_COMPACTION_CONFIG,
  );
  const conversationRecordsRef = useRef<ConversationRecord[]>([]);
  const pendingCompactionRef = useRef<PendingCompaction | null>(null);
  const compactionSequenceRef = useRef(0);

  const setStatusValue = useCallback((nextStatus: BriefingStatus) => {
    statusRef.current = nextStatus;
    setStatus(nextStatus);
  }, []);

  const setBriefingSessionIdValue = useCallback((nextSessionId: string | null) => {
    briefingSessionIdRef.current = nextSessionId;
    setBriefingSessionId(nextSessionId);
  }, []);

  const setMutedValue = useCallback((nextMuted: boolean) => {
    isMutedRef.current = nextMuted;
    setIsMuted(nextMuted);
  }, []);

  const startUserTurn = useCallback((userTurn: string) => {
    currentUserTurnRef.current = userTurn;
    previousToolCallsRef.current = [];
  }, []);

  const clearUserTurnContext = useCallback(() => {
    currentUserTurnRef.current = "";
    previousToolCallsRef.current = [];
  }, []);

  const flushTraceNow = useCallback(
    async (options: { sessionId?: string | null; keepalive?: boolean } = {}) => {
      if (traceFlushTimerRef.current !== null) {
        window.clearTimeout(traceFlushTimerRef.current);
        traceFlushTimerRef.current = null;
      }

      if (!observabilityEnabledRef.current) {
        traceEventsRef.current = [];
        traceFlagsRef.current = [];
        return;
      }

      const sessionId = options.sessionId ?? briefingSessionIdRef.current;
      if (!sessionId) {
        return;
      }

      const events = traceEventsRef.current.splice(0);
      const flags = traceFlagsRef.current.splice(0);
      if (events.length === 0 && flags.length === 0) {
        return;
      }

      try {
        await fetch("/api/briefing/trace", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            briefingSessionId: sessionId,
            events,
            flags,
          }),
          keepalive: options.keepalive,
        });
      } catch {
        // Client observability is best-effort.
      }
    },
    [],
  );

  const scheduleTraceFlush = useCallback(() => {
    if (!observabilityEnabledRef.current || traceFlushTimerRef.current !== null) {
      return;
    }

    traceFlushTimerRef.current = window.setTimeout(() => {
      traceFlushTimerRef.current = null;
      void flushTraceNow();
    }, 2000);
  }, [flushTraceNow]);

  const queueTraceEvent = useCallback(
    (event: ClientTraceEvent) => {
      if (!observabilityEnabledRef.current) {
        return;
      }
      traceEventsRef.current.push({
        ...event,
        textExcerpt:
          typeof event.textExcerpt === "string"
            ? normalizeTraceText(event.textExcerpt)
            : event.textExcerpt,
      });
      scheduleTraceFlush();
    },
    [scheduleTraceFlush],
  );

  const queueTraceFlags = useCallback(
    (flags: ClientTraceFlag[]) => {
      if (!observabilityEnabledRef.current || flags.length === 0) {
        return;
      }
      traceFlagsRef.current.push(...flags);
      scheduleTraceFlush();
    },
    [scheduleTraceFlush],
  );

  const commitTranscriptState = useCallback(() => {
    const ordered = buildOrderedTranscriptItems(
      transcriptNodesRef.current,
      itemMetadataRef.current,
    );
    startTransition(() => {
      setTranscriptItems(ordered);
    });
  }, []);

  const resetConversationState = useCallback(() => {
    nextSortOrderRef.current = 0;
    nextSyntheticIdRef.current = 0;
    itemMetadataRef.current.clear();
    transcriptNodesRef.current.clear();
    functionCallsRef.current.clear();
    if (traceFlushTimerRef.current !== null) {
      window.clearTimeout(traceFlushTimerRef.current);
      traceFlushTimerRef.current = null;
    }
    traceEventsRef.current = [];
    traceFlagsRef.current = [];
    currentUserTurnRef.current = "";
    assistantTextByResponseRef.current.clear();
    previousToolCallsRef.current = [];
    responseCreatedAtRef.current.clear();
    responseFirstAudioTranscriptTracedRef.current.clear();
    compactionConfigRef.current = DEFAULT_COMPACTION_CONFIG;
    conversationRecordsRef.current = [];
    if (pendingCompactionRef.current) {
      window.clearTimeout(pendingCompactionRef.current.timeoutId);
      pendingCompactionRef.current = null;
    }
    responseInFlightRef.current = false;
    setTranscriptItems([]);
  }, []);

  const nextSortOrder = useCallback(() => {
    const current = nextSortOrderRef.current;
    nextSortOrderRef.current += 1;
    return current;
  }, []);

  const ensureItemMetadata = useCallback(
    (itemId: string, previousItemId: string | null) => {
      const existing = itemMetadataRef.current.get(itemId);
      if (existing) {
        itemMetadataRef.current.set(itemId, {
          previousItemId: previousItemId ?? existing.previousItemId,
          sortOrder: existing.sortOrder,
        });
        return existing.sortOrder;
      }

      const sortOrder = nextSortOrder();
      itemMetadataRef.current.set(itemId, {
        previousItemId,
        sortOrder,
      });
      return sortOrder;
    },
    [nextSortOrder],
  );

  const upsertTranscriptNode = useCallback(
    (options: {
      itemId: string | null;
      role: BriefingTranscriptItem["role"];
      previousItemId?: string | null;
      appendText?: string;
      replaceText?: string;
      status?: BriefingTranscriptItem["status"];
      fallbackId?: string;
    }) => {
      const key =
        options.itemId ??
        options.fallbackId ??
        `ephemeral-${nextSyntheticIdRef.current++}`;
      const existing = transcriptNodesRef.current.get(key);
      const metadataSortOrder = options.itemId
        ? ensureItemMetadata(
            options.itemId,
            options.previousItemId ??
              itemMetadataRef.current.get(options.itemId)?.previousItemId ??
              null,
          )
        : null;
      const previousItemId =
        options.previousItemId ??
        (options.itemId
          ? itemMetadataRef.current.get(options.itemId)?.previousItemId ?? null
          : null);
      const node =
        existing ??
        createTranscriptNode(
          key,
          options.role,
          options.itemId,
          previousItemId,
          metadataSortOrder ?? nextSortOrder(),
        );

      const nextText =
        options.replaceText ??
        (options.appendText ? `${node.text}${options.appendText}` : node.text);

      transcriptNodesRef.current.set(key, {
        ...node,
        role: options.role,
        itemId: options.itemId ?? node.itemId,
        previousItemId:
          previousItemId ?? node.previousItemId ?? null,
        text: nextText,
        status: options.status ?? node.status,
        sortOrder: metadataSortOrder ?? node.sortOrder,
      });
      commitTranscriptState();
    },
    [commitTranscriptState, ensureItemMetadata, nextSortOrder],
  );

  const finalizeStreamingNodes = useCallback(
    (role?: BriefingTranscriptItem["role"]) => {
      let changed = false;

      for (const [key, node] of transcriptNodesRef.current.entries()) {
        if (role && node.role !== role) {
          continue;
        }

        if (node.status !== "streaming") {
          continue;
        }

        transcriptNodesRef.current.set(key, {
          ...node,
          status: node.text ? "complete" : "failed",
        });
        changed = true;
      }

      if (changed) {
        commitTranscriptState();
      }
    },
    [commitTranscriptState],
  );

  const getAssistantTextBeforeTool = useCallback((callState: ToolCallState) => {
    if (callState.responseId) {
      const responseText = assistantTextByResponseRef.current.get(callState.responseId);
      if (responseText) {
        return responseText;
      }
    }

    const assistantNodes = [...transcriptNodesRef.current.values()]
      .filter((node) => node.role === "assistant" && node.text.trim())
      .sort((left, right) => right.sortOrder - left.sortOrder);
    return assistantNodes[0]?.text ?? "";
  }, []);

  const closeLocalRuntime = useCallback(() => {
    const runtime = runtimeRef.current;
    if (!runtime) {
      return;
    }

    runtime.closedByClient = true;
    try {
      runtime.dataChannel.close();
    } catch {
      // Ignore local teardown errors.
    }
    try {
      runtime.peerConnection.close();
    } catch {
      // Ignore local teardown errors.
    }

    stopMediaStream(runtime.localStream);
    stopMediaStream(runtime.remoteStream);
    detachAudioElement(runtime.remoteAudio);
    runtimeRef.current = null;
    setRemoteStream(null);
  }, []);

  const bestEffortCloseSessionOnServer = useCallback((sessionId: string) => {
    const requestBody = JSON.stringify({
      briefingSessionId: sessionId,
    });

    if (typeof navigator.sendBeacon === "function") {
      try {
        const beaconBody = new Blob([requestBody], {
          type: "application/json",
        });
        if (navigator.sendBeacon("/api/briefing/end", beaconBody)) {
          return;
        }
      } catch {
        // Fall back to keepalive fetch below.
      }
    }

    try {
      void fetch("/api/briefing/end", {
        ...buildEndRouteRequestInit(sessionId),
        body: requestBody,
      });
    } catch {
      // Page teardown cleanup is best-effort.
    }
  }, []);

  const closeSessionOnServer = useCallback(async (sessionId: string) => {
    try {
      await fetch("/api/briefing/end", buildEndRouteRequestInit(sessionId));
    } catch {
      // Explicit end is best-effort after local teardown.
    }
  }, []);

  const cleanupSessionForPageTeardown = useCallback(() => {
    const sessionId = briefingSessionIdRef.current;
    if (pendingCompactionRef.current) {
      window.clearTimeout(pendingCompactionRef.current.timeoutId);
      pendingCompactionRef.current = null;
    }
    // Only invalidate the run if a session was actually established.
    // Bumping runId unconditionally kills in-flight startup during
    // React strict-mode's unmount/remount cycle.
    if (sessionId) {
      runIdRef.current += 1;
      void flushTraceNow({ sessionId, keepalive: true });
      closeLocalRuntime();
      briefingSessionIdRef.current = null;
      bestEffortCloseSessionOnServer(sessionId);
    }
  }, [bestEffortCloseSessionOnServer, closeLocalRuntime, flushTraceNow]);

  const tearDownSession = useCallback(
    async (options: {
      nextStatus: BriefingStatus;
      errorCode?: string;
      notifyServer?: boolean;
      clearSessionId?: boolean;
      clearError?: boolean;
    }) => {
      const sessionId = briefingSessionIdRef.current;
      const shouldNotifyServer = Boolean(options.notifyServer && sessionId);

      runIdRef.current += 1;
      closeLocalRuntime();
      finalizeStreamingNodes("assistant");
      setIsAiSpeaking(false);
      setIsUserSpeaking(false);
      setCanSendText(false);
      setMutedValue(true);
      responseInFlightRef.current = false;
      setStatusValue(options.nextStatus);

      if (options.clearError) {
        setError(null);
      } else if (options.errorCode) {
        setError(buildUiError(options.errorCode));
      }

      if (options.clearSessionId ?? true) {
        setBriefingSessionIdValue(null);
      }

      if (sessionId) {
        await flushTraceNow({ sessionId });
      }

      if (shouldNotifyServer && sessionId) {
        await closeSessionOnServer(sessionId);
      }
    },
    [
      closeLocalRuntime,
      closeSessionOnServer,
      finalizeStreamingNodes,
      flushTraceNow,
      setBriefingSessionIdValue,
      setMutedValue,
      setStatusValue,
    ],
  );

  const sendRealtimeEvent = useCallback((payload: Record<string, unknown>) => {
    const runtime = runtimeRef.current;
    if (!runtime || runtime.closedByClient || runtime.dataChannel.readyState !== "open") {
      return false;
    }

    runtime.dataChannel.send(JSON.stringify(payload));
    return true;
  }, []);

  const upsertConversationRecord = useCallback(
    (record: {
      itemId: string | null;
      type?: string | null;
      role?: string | null;
      text?: string | null;
      responseId?: string | null;
      functionCallId?: string | null;
      compactable?: boolean;
    }) => {
      if (!record.itemId) {
        return;
      }

      const existingIndex = conversationRecordsRef.current.findIndex(
        (item) => item.itemId === record.itemId,
      );
      const existing =
        existingIndex >= 0
          ? conversationRecordsRef.current[existingIndex]
          : null;
      const nextRecord: ConversationRecord = {
        itemId: record.itemId,
        type: record.type ?? existing?.type ?? null,
        role: record.role ?? existing?.role ?? null,
        text: record.text ?? existing?.text ?? "",
        responseId: record.responseId ?? existing?.responseId ?? null,
        functionCallId:
          record.functionCallId ?? existing?.functionCallId ?? null,
        createdAt: existing?.createdAt ?? Date.now(),
        serverDeleted: existing?.serverDeleted ?? false,
        compactable: record.compactable ?? existing?.compactable ?? true,
      };

      if (existingIndex >= 0) {
        conversationRecordsRef.current[existingIndex] = nextRecord;
      } else {
        conversationRecordsRef.current.push(nextRecord);
      }
    },
    [],
  );

  const abortPendingCompaction = useCallback(
    (reason: string) => {
      const pending = pendingCompactionRef.current;
      if (!pending) {
        return;
      }

      window.clearTimeout(pending.timeoutId);
      pendingCompactionRef.current = null;
      queueTraceEvent({
        eventType: "realtime.compaction.aborted",
        resultSummaryJson: {
          reason,
          delete_item_count: pending.deleteItemIds.length,
        },
      });
    },
    [queueTraceEvent],
  );

  const markConversationRecordDeleted = useCallback(
    (itemId: string | null) => {
      if (!itemId) {
        return;
      }

      let deletedCount = 0;
      conversationRecordsRef.current = conversationRecordsRef.current.map((record) => {
        if (record.itemId !== itemId) {
          return record;
        }

        deletedCount += record.serverDeleted ? 0 : 1;
        return {
          ...record,
          serverDeleted: true,
        };
      });

      if (deletedCount > 0) {
        queueTraceEvent({
          eventType: "realtime.compaction.item_deleted",
          itemId,
          resultSummaryJson: {
            deleted_item_count: deletedCount,
          },
        });
      }
    },
    [queueTraceEvent],
  );

  const sendCompactionDeletes = useCallback(
    (pending: PendingCompaction) => {
      for (const itemId of pending.deleteItemIds) {
        const eventId = `briefing_compaction_delete_${itemId}`;
        if (
          !sendRealtimeEvent({
            event_id: eventId,
            type: "conversation.item.delete",
            item_id: itemId,
          })
        ) {
          queueTraceEvent({
            eventType: "realtime.compaction.delete_failed",
            itemId,
            resultSummaryJson: {
              reason: "send_failed",
            },
          });
        }
      }

      queueTraceEvent({
        eventType: "realtime.compaction.completed",
        resultSummaryJson: {
          deleted_item_count: pending.deleteItemIds.length,
        },
      });
    },
    [queueTraceEvent, sendRealtimeEvent],
  );

  const confirmPendingCompactionSummary = useCallback(
    (itemId: string | null, text: string) => {
      const pending = pendingCompactionRef.current;
      if (!pending || text !== pending.summaryText) {
        return false;
      }

      window.clearTimeout(pending.timeoutId);
      pendingCompactionRef.current = null;
      upsertConversationRecord({
        itemId,
        type: "message",
        role: "system",
        text,
        compactable: false,
      });
      sendCompactionDeletes(pending);
      return true;
    },
    [sendCompactionDeletes, upsertConversationRecord],
  );

  const maybeCompactConversation = useCallback(
    (inputTokens: number | null) => {
      const config = compactionConfigRef.current;
      if (
        !config.enabled ||
        inputTokens === null ||
        inputTokens < config.triggerInputTokens ||
        responseInFlightRef.current ||
        pendingCompactionRef.current
      ) {
        return;
      }

      const liveRecords = conversationRecordsRef.current.filter(
        (record) => !record.serverDeleted,
      );
      const preservedIds = new Set(
        liveRecords
          .slice(-config.keepRecentItemCount)
          .map((record) => record.itemId),
      );
      const candidates = liveRecords.filter(
        (record) => record.compactable && !preservedIds.has(record.itemId),
      );

      if (candidates.length < config.minDeleteItemCount) {
        return;
      }

      const summaryText = buildConversationCompactionSummary(candidates);
      const sequence = compactionSequenceRef.current + 1;
      compactionSequenceRef.current = sequence;
      const summaryEventId = `briefing_compaction_summary_${sequence}`;
      const timeoutId = window.setTimeout(() => {
        abortPendingCompaction("summary_timeout");
      }, COMPACTION_SUMMARY_TIMEOUT_MS);
      const pending: PendingCompaction = {
        summaryEventId,
        summaryText,
        deleteItemIds: candidates.map((record) => record.itemId),
        timeoutId,
      };

      pendingCompactionRef.current = pending;
      const sent = sendRealtimeEvent({
        event_id: summaryEventId,
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "system",
          content: [
            {
              type: "input_text",
              text: summaryText,
            },
          ],
        },
      });

      if (!sent) {
        abortPendingCompaction("summary_send_failed");
        return;
      }

      queueTraceEvent({
        eventType: "realtime.compaction.started",
        resultSummaryJson: {
          input_tokens: inputTokens,
          candidate_item_count: candidates.length,
          keep_recent_item_count: config.keepRecentItemCount,
        },
      });
    },
    [abortPendingCompaction, queueTraceEvent, sendRealtimeEvent],
  );

  const requestAssistantResponse = useCallback(() => {
    if (responseInFlightRef.current) {
      return;
    }

    if (
      sendRealtimeEvent({
        type: "response.create",
      })
    ) {
      responseInFlightRef.current = true;
    }
  }, [sendRealtimeEvent]);

  const setPendingToolRelay = useCallback(
    (
      functionCallId: string,
      pendingRelay: {
        output: unknown;
        requestAssistantResponse: boolean;
      },
    ) => {
      const current = functionCallsRef.current.get(functionCallId);
      if (!current) {
        return false;
      }

      current.pendingRelay = pendingRelay;
      return true;
    },
    [],
  );

  const relayToolOutputIfReady = useCallback(
    async (functionCallId: string, runId: number) => {
      if (runIdRef.current !== runId) {
        return;
      }

      const callState = functionCallsRef.current.get(functionCallId);
      if (
        !callState ||
        callState.relaySent ||
        !callState.pendingRelay ||
        !isToolCallReadyForRelay(callState)
      ) {
        return;
      }

      callState.relaySent = true;
      const relayed = sendRealtimeEvent({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: functionCallId,
          output: stringifyFunctionCallOutput(callState.pendingRelay.output),
        },
      });

      if (!relayed) {
        await tearDownSession({
          nextStatus: "error",
          errorCode: "connection_failed",
          notifyServer: true,
        });
        return;
      }

      if (callState.pendingRelay.requestAssistantResponse) {
        requestAssistantResponse();
      }
    },
    [requestAssistantResponse, sendRealtimeEvent, tearDownSession],
  );

  const handleTransportLoss = useCallback(async () => {
    const runtime = runtimeRef.current;
    if (!runtime || runtime.closedByClient) {
      return;
    }

    await tearDownSession({
      nextStatus: "error",
      errorCode: "transport_lost",
      notifyServer: true,
    });
  }, [tearDownSession]);

  const executeToolCall = useCallback(
    async (functionCallId: string, runId: number) => {
      if (runIdRef.current !== runId) {
        return;
      }

      const callState = functionCallsRef.current.get(functionCallId);
      if (!callState || callState.executionStarted) {
        return;
      }

      if (!callState.argumentsComplete) {
        return;
      }

      if (callState.responseCompleted && callState.responseStatus !== "completed") {
        return;
      }

      const sessionId = briefingSessionIdRef.current;
      if (!sessionId) {
        return;
      }

      callState.executionStarted = true;

      const parsedArguments = parseToolArguments(
        callState.toolName,
        callState.argumentsText,
      );

      const relayLocalFailure = (output: unknown = RELAYABLE_TOOL_FAILURE) => {
        if (runIdRef.current !== runId) {
          return;
        }

        setPendingToolRelay(functionCallId, {
          output,
          requestAssistantResponse: true,
        });
        void relayToolOutputIfReady(functionCallId, runId);
      };

      if (!parsedArguments || !callState.toolName) {
        relayLocalFailure();
        return;
      }

      const assistantTextBeforeTool = getAssistantTextBeforeTool(callState);
      queueTraceEvent({
        eventType: "tool.call",
        responseId: callState.responseId,
        itemId: callState.itemId,
        functionCallId,
        toolName: callState.toolName,
        role: "assistant",
        textExcerpt: assistantTextBeforeTool,
        argumentsJson: parsedArguments,
      });

      let executableToolCall: BriefingRuntimeToolCall = {
        functionCallId,
        toolName: callState.toolName,
        arguments: parsedArguments,
        responseId: callState.responseId,
        itemId: callState.itemId,
      };
      if (observabilityEnabledRef.current) {
        const runtimeEval = applyBriefingRuntimeToolCall({
          currentUserTurn: currentUserTurnRef.current,
          assistantTextBeforeTool,
          proposedToolCall: executableToolCall,
          previousToolCalls: previousToolCallsRef.current,
        });
        queueTraceFlags(runtimeEval.flags);
        executableToolCall = runtimeEval.effectiveToolCall;

        if (runtimeEval.completedRecord) {
          previousToolCallsRef.current.push(runtimeEval.completedRecord);
          queueTraceEvent({
            eventType: "tool.result",
            responseId: callState.responseId,
            itemId: callState.itemId,
            functionCallId,
            toolName: callState.toolName,
            role: "tool",
            resultSummaryJson: summarizeClientToolOutput(
              runtimeEval.syntheticToolOutput,
            ),
          });

          setPendingToolRelay(functionCallId, {
            output: runtimeEval.syntheticToolOutput,
            requestAssistantResponse: true,
          });
          await relayToolOutputIfReady(functionCallId, runId);
          return;
        }
      }

      if (callState.toolName === "wait_for_user") {
        const output = { waited: true };
        previousToolCallsRef.current.push({
          functionCallId,
          toolName: callState.toolName,
          arguments: executableToolCall.arguments,
          output,
        });

        queueTraceEvent({
          eventType: "tool.result",
          responseId: callState.responseId,
          itemId: callState.itemId,
          functionCallId,
          toolName: callState.toolName,
          role: "tool",
          resultSummaryJson: summarizeClientToolOutput(output),
        });

        setPendingToolRelay(functionCallId, {
          output,
          requestAssistantResponse: false,
        });
        await relayToolOutputIfReady(functionCallId, runId);
        return;
      }

      let response: Response;
      const toolRequestStartedAt = Date.now();
      try {
        response = await fetch("/api/briefing/tool", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            briefingSessionId: sessionId,
            functionCallId,
            toolName: callState.toolName,
            arguments: executableToolCall.arguments,
          }),
        });
      } catch {
        if (runIdRef.current !== runId) {
          return;
        }

        await tearDownSession({
          nextStatus: "error",
          errorCode: "connection_failed",
          notifyServer: true,
        });
        return;
      }

      const responseBody = await readJsonSafely(response);
      const toolRouteLatencyMs = Date.now() - toolRequestStartedAt;
      const routeErrorCode = readJsonErrorCode(responseBody);

      if (runIdRef.current !== runId) {
        return;
      }

      if (response.ok) {
        const parsedSuccess = parseToolRouteSuccess(responseBody);
        if (!parsedSuccess || parsedSuccess.functionCallId !== functionCallId) {
          await tearDownSession({
            nextStatus: "error",
            errorCode: "connection_failed",
            notifyServer: true,
          });
          return;
        }

        let output = parsedSuccess.output;
        if (observabilityEnabledRef.current) {
          const resultEval = applyBriefingRuntimeToolResult({
            currentUserTurn: currentUserTurnRef.current,
            toolCall: executableToolCall,
            toolOutput: parsedSuccess.output,
            previousToolCalls: previousToolCallsRef.current,
          });
          queueTraceFlags(resultEval.flags);
          output = resultEval.output;
          previousToolCallsRef.current.push(resultEval.completedRecord);
        } else {
          previousToolCallsRef.current.push({
            functionCallId,
            toolName: callState.toolName,
            arguments: executableToolCall.arguments,
            output,
          });
        }

        queueTraceEvent({
          eventType: "tool.result",
          responseId: callState.responseId,
          itemId: callState.itemId,
          functionCallId,
          toolName: callState.toolName,
          role: "tool",
          resultSummaryJson: summarizeClientToolOutput(output),
          latencyMs: toolRouteLatencyMs,
        });

        setPendingToolRelay(functionCallId, {
          output,
          requestAssistantResponse: true,
        });
        await relayToolOutputIfReady(functionCallId, runId);
        return;
      }

      if (routeErrorCode === "session_expired") {
        await tearDownSession({
          nextStatus: "error",
          errorCode: "session_expired",
          notifyServer: false,
        });
        return;
      }

      if (routeErrorCode && TOOL_REQUEST_ERROR_CODES.has(routeErrorCode)) {
        await tearDownSession({
          nextStatus: "error",
          errorCode:
            routeErrorCode === "invalid_session" ? "connection_failed" : routeErrorCode,
          notifyServer: true,
        });
        return;
      }

      const relayableRouteFailure = {
        error: routeErrorCode ?? "tool_route_failed",
        status: response.status,
        retryable: true,
      } as const;

      // Non-session errors (invalid_arguments, invalid_request_body,
      // tool_call_in_progress, briefing_tool_failed, etc.) are recoverable.
      // Relay the route failure to the model so the conversation continues
      // and can answer when the user asks for the exact tool error.
      queueTraceEvent({
        eventType: "tool.result",
        responseId: callState.responseId,
        itemId: callState.itemId,
        functionCallId,
        toolName: callState.toolName,
        role: "tool",
        resultSummaryJson: relayableRouteFailure,
        latencyMs: toolRouteLatencyMs,
      });
      relayLocalFailure(relayableRouteFailure);
    },
    [
      getAssistantTextBeforeTool,
      queueTraceEvent,
      queueTraceFlags,
      relayToolOutputIfReady,
      setPendingToolRelay,
      tearDownSession,
    ],
  );

  const handleRealtimeEvent = useCallback(
    (payload: Record<string, unknown>, runId: number) => {
      if (runIdRef.current !== runId) {
        return;
      }

      const type = readString(payload.type);
      if (!type) {
        return;
      }

      if (type === "error") {
        const eventId = readString(payload.event_id);
        const pending = pendingCompactionRef.current;
        if (pending && eventId === pending.summaryEventId) {
          abortPendingCompaction("summary_error");
          return;
        }

        if (eventId?.startsWith("briefing_compaction_delete_")) {
          const itemId = eventId.replace("briefing_compaction_delete_", "");
          queueTraceEvent({
            eventType: "realtime.compaction.delete_failed",
            itemId,
            resultSummaryJson: {
              reason: "server_error",
              code: readString(payload.code),
              message: readString(payload.message),
            },
          });
        }
        return;
      }

      if (type.startsWith("response.") && type !== "response.done") {
        responseInFlightRef.current = true;
      }

      if (type === "response.created") {
        const response = isRecord(payload.response) ? payload.response : null;
        const responseId = response
          ? readNullableString(response.id)
          : readNullableString(payload.response_id);
        if (responseId) {
          responseCreatedAtRef.current.set(responseId, Date.now());
        }
        queueTraceEvent({
          eventType: "realtime.response.created",
          responseId,
          role: "assistant",
          resultSummaryJson: {
            status: response ? readString(response.status) : null,
          },
        });
        return;
      }

      if (type === "response.output_audio_transcript.delta") {
        const itemId = readNullableString(payload.item_id);
        const delta = readString(payload.delta);
        if (!delta) {
          return;
        }

        const responseId = readString(payload.response_id);
        if (responseId) {
          const responseCreatedAt = responseCreatedAtRef.current.get(responseId);
          if (
            responseCreatedAt !== undefined &&
            !responseFirstAudioTranscriptTracedRef.current.has(responseId)
          ) {
            responseFirstAudioTranscriptTracedRef.current.add(responseId);
            queueTraceEvent({
              eventType: "realtime.response.first_audio_transcript_delta",
              responseId,
              itemId,
              role: "assistant",
              latencyMs: Date.now() - responseCreatedAt,
            });
          }
          assistantTextByResponseRef.current.set(
            responseId,
            `${assistantTextByResponseRef.current.get(responseId) ?? ""}${delta}`,
          );
        }
        setIsAiSpeaking(true);
        upsertTranscriptNode({
          itemId,
          role: "assistant",
          appendText: delta,
          status: "streaming",
          fallbackId: readString(payload.response_id) ?? undefined,
        });
        return;
      }

      if (type === "response.output_audio_transcript.done") {
        const itemId = readNullableString(payload.item_id);
        const transcript = readString(payload.transcript);
        const responseId = readString(payload.response_id);
        if (responseId && transcript) {
          assistantTextByResponseRef.current.set(responseId, transcript);
        }
        if (transcript) {
          upsertConversationRecord({
            itemId,
            type: "message",
            role: "assistant",
            text: transcript,
            responseId,
          });
        }
        setIsAiSpeaking(false);
        upsertTranscriptNode({
          itemId,
          role: "assistant",
          replaceText: transcript ?? undefined,
          status: "complete",
          fallbackId: readString(payload.response_id) ?? undefined,
        });
        return;
      }

      if (type === "conversation.item.input_audio_transcription.delta") {
        const itemId = readNullableString(payload.item_id);
        const delta = readString(payload.delta);
        if (!delta) {
          return;
        }

        setIsUserSpeaking(true);
        upsertTranscriptNode({
          itemId,
          role: "user",
          appendText: delta,
          status: "streaming",
        });
        return;
      }

      if (type === "conversation.item.input_audio_transcription.completed") {
        const itemId = readNullableString(payload.item_id);
        const transcript = readString(payload.transcript);
        if (transcript) {
          startUserTurn(transcript);
          queueTraceEvent({
            eventType: "user.transcript",
            itemId,
            role: "user",
            textExcerpt: transcript,
          });
        }
        queueTraceEvent({
          eventType: "realtime.transcription.completed",
          itemId,
          role: "user",
          textExcerpt: transcript ?? null,
          resultSummaryJson: {
            usage: extractTranscriptionUsage(payload.usage),
          },
        });
        upsertConversationRecord({
          itemId,
          type: "message",
          role: "user",
          text: transcript ?? "",
        });
        setIsUserSpeaking(false);
        upsertTranscriptNode({
          itemId,
          role: "user",
          replaceText: transcript ?? undefined,
          status: "complete",
        });
        return;
      }

      if (type === "conversation.item.input_audio_transcription.failed") {
        const itemId = readNullableString(payload.item_id);
        clearUserTurnContext();
        setIsUserSpeaking(false);
        upsertTranscriptNode({
          itemId,
          role: "user",
          replaceText: "Transcription unavailable.",
          status: "failed",
        });
        return;
      }

      if (type === "conversation.item.created") {
        const item = isRecord(payload.item) ? payload.item : null;
        const itemId = item ? readString(item.id) : null;
        const previousItemId = readNullableString(payload.previous_item_id);
        if (itemId) {
          ensureItemMetadata(itemId, previousItemId);
        }

        if (!item) {
          commitTranscriptState();
          return;
        }

        const itemType = readString(item.type);
        const role = readString(item.role);
        const text = extractContentText(item.content);
        const functionCallId = readString(item.call_id);
        upsertConversationRecord({
          itemId,
          type: itemType,
          role,
          text:
            text ||
            readString(item.output) ||
            readString(item.arguments) ||
            "",
          responseId: readNullableString(item.response_id),
          functionCallId,
          compactable: role !== "system",
        });

        if (role === "system" && text) {
          if (confirmPendingCompactionSummary(itemId, text)) {
            commitTranscriptState();
            return;
          }
        }

        if (itemType !== "message") {
          commitTranscriptState();
          return;
        }

        if ((role === "user" || role === "assistant") && text) {
          upsertTranscriptNode({
            itemId,
            role,
            previousItemId,
            replaceText: text,
            status: "complete",
          });
          return;
        }

        commitTranscriptState();
        return;
      }

      if (type === "input_audio_buffer.committed") {
        const itemId = readString(payload.item_id);
        const previousItemId = readNullableString(payload.previous_item_id);
        if (itemId) {
          ensureItemMetadata(itemId, previousItemId);
          upsertConversationRecord({
            itemId,
            type: "message",
            role: "user",
          });
          commitTranscriptState();
        }
        queueTraceEvent({
          eventType: "realtime.input.committed",
          itemId,
          role: "user",
        });
        setIsUserSpeaking(false);
        return;
      }

      if (type === "input_audio_buffer.speech_started") {
        queueTraceEvent({
          eventType: "realtime.input.speech_started",
          itemId: readNullableString(payload.item_id),
          role: "user",
        });
        setIsUserSpeaking(true);
        return;
      }

      if (type === "input_audio_buffer.speech_stopped") {
        queueTraceEvent({
          eventType: "realtime.input.speech_stopped",
          itemId: readNullableString(payload.item_id),
          role: "user",
        });
        setIsUserSpeaking(false);
        return;
      }

      if (type === "output_audio_buffer.started") {
        setIsAiSpeaking(true);
        return;
      }
      if (type === "output_audio_buffer.stopped") {
        setIsAiSpeaking(false);
        return;
      }

      if (type === "response.function_call_arguments.delta") {
        const functionCallId = readString(payload.call_id);
        if (!functionCallId) {
          return;
        }

        const existing = functionCallsRef.current.get(functionCallId);
        const toolName = parseBriefingToolName(payload.name);
        functionCallsRef.current.set(functionCallId, {
          functionCallId,
          itemId: readNullableString(payload.item_id) ?? existing?.itemId ?? null,
          responseId:
            readNullableString(payload.response_id) ?? existing?.responseId ?? null,
          toolName: toolName ?? existing?.toolName ?? null,
          argumentsText: `${existing?.argumentsText ?? ""}${readString(payload.delta) ?? ""}`,
          argumentsComplete: existing?.argumentsComplete ?? false,
          responseStatus: existing?.responseStatus ?? null,
          responseCompleted: existing?.responseCompleted ?? false,
          matchedResponseOutput: existing?.matchedResponseOutput ?? false,
          executionStarted: existing?.executionStarted ?? false,
          pendingRelay: existing?.pendingRelay ?? null,
          relaySent: existing?.relaySent ?? false,
        });
        return;
      }

      if (type === "response.function_call_arguments.done") {
        const functionCallId = readString(payload.call_id);
        if (!functionCallId) {
          return;
        }

        const existing = functionCallsRef.current.get(functionCallId);
        const toolName = parseBriefingToolName(payload.name);
        const argumentsText =
          readString(payload.arguments) ?? existing?.argumentsText ?? "";
        functionCallsRef.current.set(functionCallId, {
          functionCallId,
          itemId: readNullableString(payload.item_id) ?? existing?.itemId ?? null,
          responseId:
            readNullableString(payload.response_id) ?? existing?.responseId ?? null,
          toolName: toolName ?? existing?.toolName ?? null,
          argumentsText,
          argumentsComplete: true,
          responseStatus: existing?.responseStatus ?? null,
          responseCompleted: existing?.responseCompleted ?? false,
          matchedResponseOutput: existing?.matchedResponseOutput ?? false,
          executionStarted: existing?.executionStarted ?? false,
          pendingRelay: existing?.pendingRelay ?? null,
          relaySent: existing?.relaySent ?? false,
        });
        void executeToolCall(functionCallId, runId);
        return;
      }

      if (type === "response.output_item.done") {
        const item = isRecord(payload.item) ? payload.item : null;
        if (!item) {
          return;
        }

        const itemId = readNullableString(item.id);
        const itemType = readString(item.type);
        const functionCallId = readString(item.call_id);
        if (itemId) {
          ensureItemMetadata(itemId, readNullableString(item.previous_item_id));
          upsertConversationRecord({
            itemId,
            type: itemType,
            role: readString(item.role),
            text:
              extractContentText(item.content) ||
              readString(item.arguments) ||
              readString(item.output) ||
              "",
            responseId: readNullableString(payload.response_id),
            functionCallId,
          });
        }

        if (itemType !== "function_call") {
          return;
        }

        if (!functionCallId) {
          return;
        }

        const existing = functionCallsRef.current.get(functionCallId);
        const toolName = parseBriefingToolName(item.name);

        functionCallsRef.current.set(functionCallId, {
          functionCallId,
          itemId: itemId ?? existing?.itemId ?? null,
          responseId:
            readNullableString(payload.response_id) ?? existing?.responseId ?? null,
          toolName: toolName ?? existing?.toolName ?? null,
          argumentsText:
            readString(item.arguments) ?? existing?.argumentsText ?? "",
          argumentsComplete:
            readString(item.arguments) !== null || existing?.argumentsComplete || false,
          responseStatus: existing?.responseStatus ?? null,
          responseCompleted: existing?.responseCompleted ?? false,
          matchedResponseOutput: existing?.matchedResponseOutput ?? false,
          executionStarted: existing?.executionStarted ?? false,
          pendingRelay: existing?.pendingRelay ?? null,
          relaySent: existing?.relaySent ?? false,
        });
        return;
      }

      if (type === "conversation.item.deleted") {
        markConversationRecordDeleted(readString(payload.item_id));
        return;
      }

      if (type === "response.done") {
        responseInFlightRef.current = false;
        setIsAiSpeaking(false);

        const response = isRecord(payload.response) ? payload.response : null;
        if (!response) {
          finalizeStreamingNodes("assistant");
          return;
        }

        const responseId = readNullableString(response.id);
        const responseStatus = readString(response.status);
        const outputs = extractFunctionCallOutputs(response);
        const completed = responseStatus === "completed";
        const usage = extractRealtimeUsage(response.usage);
        const phaseSummary = extractRealtimePhaseSummary(response.output);
        const responseCreatedAt = responseId
          ? responseCreatedAtRef.current.get(responseId)
          : undefined;
        const responseDurationMs =
          responseCreatedAt === undefined ? null : Date.now() - responseCreatedAt;
        queueTraceEvent({
          eventType: "response.done",
          responseId,
          role: "assistant",
          resultSummaryJson: {
            status: responseStatus,
            usage,
            phase_summary: phaseSummary,
            function_call_count: outputs.length,
            response_duration_ms: responseDurationMs,
          },
          latencyMs: responseDurationMs,
        });
        if (
          completed &&
          outputs.length === 0 &&
          /\b(go deeper|more detail|tell me more|expand|dig in)\b/i.test(
            currentUserTurnRef.current,
          )
        ) {
          queueTraceFlags([
            {
              ruleId: "today_digest_deeper_without_get_digest_item",
              severity: "info",
              action: "logged",
              detailsJson: {
                userTurn: currentUserTurnRef.current,
              },
            },
          ]);
        }

        for (const output of outputs) {
          const existing = functionCallsRef.current.get(output.functionCallId);
          functionCallsRef.current.set(output.functionCallId, {
            functionCallId: output.functionCallId,
            itemId: output.itemId ?? existing?.itemId ?? null,
            responseId: responseId ?? existing?.responseId ?? null,
            toolName: output.toolName ?? existing?.toolName ?? null,
            argumentsText: output.argumentsText ?? existing?.argumentsText ?? "",
            argumentsComplete:
              existing?.argumentsComplete ??
              Boolean(output.argumentsText),
            responseStatus,
            responseCompleted: completed,
            matchedResponseOutput: true,
            executionStarted: existing?.executionStarted ?? false,
            pendingRelay: existing?.pendingRelay ?? null,
            relaySent: existing?.relaySent ?? false,
          });
        }

        for (const [functionCallId, existing] of functionCallsRef.current.entries()) {
          if (existing.responseId && responseId && existing.responseId !== responseId) {
            continue;
          }

          const matchingOutput = outputs.some(
            (output) => output.functionCallId === functionCallId,
          );
          functionCallsRef.current.set(functionCallId, {
            ...existing,
            responseId: responseId ?? existing.responseId,
            responseStatus,
            responseCompleted: completed,
            matchedResponseOutput: existing.matchedResponseOutput || matchingOutput,
          });
          void relayToolOutputIfReady(functionCallId, runId);
          void executeToolCall(functionCallId, runId);
        }

        finalizeStreamingNodes("assistant");
        maybeCompactConversation(extractRealtimeInputTokens(response.usage));
      }
    },
    [
      commitTranscriptState,
      ensureItemMetadata,
      executeToolCall,
      relayToolOutputIfReady,
      finalizeStreamingNodes,
      abortPendingCompaction,
      clearUserTurnContext,
      confirmPendingCompactionSummary,
      markConversationRecordDeleted,
      maybeCompactConversation,
      queueTraceEvent,
      queueTraceFlags,
      startUserTurn,
      upsertConversationRecord,
      upsertTranscriptNode,
    ],
  );

  const start = useCallback(async () => {
    if (statusRef.current === "connecting" || statusRef.current === "active") {
      return;
    }

    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    closeLocalRuntime();
    resetConversationState();
    observabilityEnabledRef.current = false;
    setError(null);
    setStatusValue("connecting");
    setIsAiSpeaking(false);
    setIsUserSpeaking(false);
    setCanSendText(false);
    // Keep muted state — don't reset. User starts muted by default
    // and their preference should persist across retries.
    setElapsedSeconds(0);
    setActiveStartedAt(null);
    setBriefingSessionIdValue(null);

    let serverSessionId: string | null = null;
    let remoteAudio: HTMLAudioElement | null = null;
    let remoteStream: MediaStream | null = null;
    let peerConnection: RTCPeerConnection | null = null;
    let dataChannel: RTCDataChannel | null = null;
    let localStream: MediaStream | null = null;

    const isCurrentStartupRun = () =>
      runIdRef.current === runId && isMountedRef.current;

    const cleanupPendingStartupResources = () => {
      if (runtimeRef.current?.runId === runId) {
        closeLocalRuntime();
        return;
      }

      try {
        dataChannel?.close();
      } catch {
        // Ignore local teardown errors.
      }
      try {
        peerConnection?.close();
      } catch {
        // Ignore local teardown errors.
      }
      stopMediaStream(localStream);
      stopMediaStream(remoteStream);
      detachAudioElement(remoteAudio);
    };

    const failStartup = async (errorCode: string) => {
      cleanupPendingStartupResources();
      if (serverSessionId) {
        await closeSessionOnServer(serverSessionId);
      }
      if (isCurrentStartupRun()) {
        await tearDownSession({
          nextStatus: "error",
          errorCode,
          notifyServer: false,
        });
      }
    };

    try {

      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("getUserMedia is unavailable");
      }

      remoteStream = new MediaStream();
      remoteAudio = createRemoteAudioElement(remoteStream);

      if (!isCurrentStartupRun()) {
        cleanupPendingStartupResources();
        return;
      }

      try {
        localStream = await navigator.mediaDevices.getUserMedia({
          audio: MICROPHONE_AUDIO_CONSTRAINTS,
        });

      } catch (error) {

        await failStartup(
          isMicrophoneDeniedError(error) ? "microphone_denied" : "connection_failed",
        );
        return;
      }

      if (!isCurrentStartupRun()) {
        cleanupPendingStartupResources();
        return;
      }


      peerConnection = new RTCPeerConnection();
      dataChannel = peerConnection.createDataChannel("oai-events");


      const runtime: SessionRuntime = {
        runId,
        peerConnection,
        dataChannel,
        localStream,
        remoteStream,
        remoteAudio,
        closedByClient: false,
        initialResponseSent: false,
      };
      runtimeRef.current = runtime;
      setRemoteStream(runtime.remoteStream);

      dataChannel.addEventListener("message", (event) => {
        if (runIdRef.current !== runId || runtime.closedByClient) {
          return;
        }

        const payload = parseRealtimePayload(event.data);
        if (!payload) {
          return;
        }

        handleRealtimeEvent(payload, runId);
      });

      dataChannel.addEventListener("open", () => {
        if (runIdRef.current !== runId || runtime.closedByClient) {
          return;
        }

        if (statusRef.current !== "active") {
          setStatusValue("active");
          setCanSendText(true);
          setActiveStartedAt(Date.now());
          setElapsedSeconds(0);
        }

        if (!runtime.initialResponseSent) {
          runtime.initialResponseSent = true;
          requestAssistantResponse();
        }
      });

      dataChannel.addEventListener("close", () => {
        if (runtime.closedByClient || runIdRef.current !== runId) {
          return;
        }

        void handleTransportLoss();
      });

      dataChannel.addEventListener("error", () => {
        if (runtime.closedByClient || runIdRef.current !== runId) {
          return;
        }

        void handleTransportLoss();
      });

      peerConnection.addEventListener("track", (event) => {
        if (runtime.closedByClient || runIdRef.current !== runId) {
          return;
        }

        if (event.streams.length > 0) {
          // Use the WebRTC-provided stream which has the actual audio track.
          // Update both the audio element AND the React state so the
          // volume analysis hook gets the real audio data.
          runtime.remoteAudio.srcObject = event.streams[0];
          runtime.remoteStream = event.streams[0];
          setRemoteStream(event.streams[0]);
        } else {
          runtime.remoteStream.addTrack(event.track);
          runtime.remoteAudio.srcObject = runtime.remoteStream;
          setRemoteStream(runtime.remoteStream);
        }
        // Start playback now that remote tracks are available
        runtime.remoteAudio.play().catch(() => {
          /* autoplay blocked — user will need to interact */
        });
      });

      peerConnection.addEventListener("connectionstatechange", () => {
        if (runtime.closedByClient || runIdRef.current !== runId) {
          return;
        }

        if (
          peerConnection?.connectionState === "failed" ||
          peerConnection?.connectionState === "closed"
        ) {
          void handleTransportLoss();
        }
      });


      for (const track of localStream.getAudioTracks()) {
        track.enabled = !isMutedRef.current;
        peerConnection.addTrack(track, localStream);
      }


      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);

      const localSdp = peerConnection.localDescription?.sdp;
      if (!localSdp) {
        throw new Error("missing_local_sdp");
      }


      const callRouteResponse = await fetch("/api/briefing/call", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          digestId,
          sdp: localSdp,
        }),
      });

      const callRouteBody = await readJsonSafely(callRouteResponse);

      if (!callRouteResponse.ok) {
        const errorCode = readJsonErrorCode(callRouteBody);
        await failStartup(
          errorCode && STARTUP_ERROR_CODES.has(errorCode)
            ? errorCode
            : "connection_failed",
        );
        return;
      }

      const parsedCallRouteSuccess = parseCallRouteSuccess(callRouteBody);
      if (!parsedCallRouteSuccess) {
        await failStartup("connection_failed");
        return;
      }

      serverSessionId = parsedCallRouteSuccess.briefingSessionId;
      observabilityEnabledRef.current =
        parsedCallRouteSuccess.observabilityEnabled;
      compactionConfigRef.current = parsedCallRouteSuccess.compaction;

      if (!isCurrentStartupRun()) {
        cleanupPendingStartupResources();
        bestEffortCloseSessionOnServer(serverSessionId);
        return;
      }

      setBriefingSessionIdValue(serverSessionId);
      await peerConnection.setRemoteDescription({
        type: "answer",
        sdp: parsedCallRouteSuccess.answerSdp,
      });

      if (!isCurrentStartupRun()) {
        cleanupPendingStartupResources();
        bestEffortCloseSessionOnServer(serverSessionId);
      }
    } catch (error) {

      if (
        error instanceof Error &&
        error.message === "missing_local_sdp"
      ) {
        await failStartup("connection_failed");
        return;
      }

      await failStartup("connection_failed");
    }
  }, [
    bestEffortCloseSessionOnServer,
    closeLocalRuntime,
    closeSessionOnServer,
    digestId,
    handleRealtimeEvent,
    handleTransportLoss,
    requestAssistantResponse,
    resetConversationState,
    setBriefingSessionIdValue,
    setStatusValue,
    tearDownSession,
  ]);

  const end = useCallback(async () => {
    await tearDownSession({
      nextStatus: "ended",
      notifyServer: true,
      clearError: true,
    });
  }, [tearDownSession]);

  const toggleMute = useCallback(() => {
    const nextMuted = !isMutedRef.current;
    const runtime = runtimeRef.current;
    if (runtime) {
      for (const track of runtime.localStream.getAudioTracks()) {
        track.enabled = !nextMuted;
      }
    }

    setMutedValue(nextMuted);
  }, [setMutedValue]);

  const sendText = useCallback(
    async (input: string) => {
      const trimmed = input.trim();
      if (!trimmed || !canSendText || statusRef.current !== "active") {
        return;
      }

      const created = sendRealtimeEvent({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: trimmed,
            },
          ],
        },
      });

      if (!created) {
        await tearDownSession({
          nextStatus: "error",
          errorCode: "connection_failed",
          notifyServer: true,
        });
        return;
      }

      startUserTurn(trimmed);
      queueTraceEvent({
        eventType: "user.text",
        role: "user",
        textExcerpt: trimmed,
      });
      requestAssistantResponse();
    },
    [
      canSendText,
      queueTraceEvent,
      requestAssistantResponse,
      sendRealtimeEvent,
      startUserTurn,
      tearDownSession,
    ],
  );

  const stopCurrentResponse = useCallback(() => {
    if (statusRef.current !== "active") {
      return;
    }

    sendRealtimeEvent({
      type: "response.cancel",
    });
    sendRealtimeEvent({
      type: "output_audio_buffer.clear",
    });
    responseInFlightRef.current = false;
    setIsAiSpeaking(false);
    finalizeStreamingNodes("assistant");
  }, [finalizeStreamingNodes, sendRealtimeEvent]);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      cleanupSessionForPageTeardown();
    };
  }, [cleanupSessionForPageTeardown]);

  useEffect(() => {
    const handlePageHide = () => {
      cleanupSessionForPageTeardown();
    };

    window.addEventListener("pagehide", handlePageHide);
    return () => {
      window.removeEventListener("pagehide", handlePageHide);
    };
  }, [cleanupSessionForPageTeardown]);

  useEffect(() => {
    if (!isMountedRef.current || status !== "active" || activeStartedAt === null) {
      return;
    }

    const tick = () => {
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - activeStartedAt) / 1000)));
    };

    tick();
    const intervalId = window.setInterval(tick, 1000);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [activeStartedAt, status]);

  return {
    status,
    transcriptItems,
    isAiSpeaking,
    isUserSpeaking,
    isMuted,
    elapsedSeconds,
    error,
    briefingSessionId,
    canSendText,
    remoteStream,
    start,
    end,
    toggleMute,
    sendText,
    stopCurrentResponse,
    clearError,
  };
}
