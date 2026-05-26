import { createHash } from "node:crypto";

import { sql } from "@/lib/db";
import {
  buildBriefingPromptPayload,
  buildPromptTokenCountRepresentation,
  estimatePromptTokens,
  getBriefingSourceItems,
  isBriefingRealtime2Model,
  resolveBriefingRealtimeModel,
} from "@/lib/briefing";
import { isBriefingObservabilityEnabled } from "@/lib/briefing-observability";
import {
  createBriefingSession,
  countActiveBriefingSessions,
} from "@/lib/briefing-session";
import {
  DEFAULT_BRIEFING_RATE_LIMITS,
  MissingClientIpError,
  consumeRateLimit,
  deriveClientIpInfo,
} from "@/lib/rate-limit";
import type { Digest } from "@/lib/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const OPENAI_CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets";
const OPENAI_REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";
const OPENAI_CREATE_CALL_TIMEOUT_MS = 10_000;
const OPENAI_HANGUP_TIMEOUT_MS = 5_000;
const TOKEN_COUNT_TIMEOUT_MS = 5_000;
const MAX_ACTIVE_SESSIONS_PER_IP = 2;
const RECOMMENDED_VOICE = "marin";
const RECOMMENDED_INPUT_NOISE_REDUCTION = "far_field";
const REALTIME2_CONTEXT_WINDOW_TOKENS = 128_000;
const CURRENT_REALTIME_STARTUP_TOKEN_CEILING = 8_000;
const BRIEFING_REALTIME_OUTPUT_TOKEN_RESERVE = 4_096;
const BRIEFING_REALTIME_MAX_OUTPUT_TOKENS = "inf";
const FALLBACK_REALTIME2_POST_INSTRUCTIONS_TOKENS = 96_000;
const TOKEN_SAFETY_MARGIN = 1_024;
const DEFAULT_REALTIME_COMPACTION_TRIGGER_INPUT_TOKENS = 24_000;
const DEFAULT_REALTIME_COMPACTION_KEEP_RECENT_ITEMS = 8;
const DEFAULT_REALTIME_COMPACTION_MIN_DELETE_ITEMS = 6;

type BriefingCallRequest = {
  digestId: number;
  sdp: string;
};

function jsonError(error: string, status = 500, extra?: Record<string, unknown>) {
  return Response.json({ error, ...extra }, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseRequestBody(value: unknown): BriefingCallRequest | null {
  if (!isRecord(value)) {
    return null;
  }

  const digestId = value.digestId;
  const sdp = value.sdp;
  if (typeof digestId !== "number" || !Number.isInteger(digestId) || digestId <= 0) {
    return null;
  }

  if (typeof sdp !== "string" || !sdp.trim()) {
    return null;
  }

  return {
    digestId,
    sdp,
  };
}

function startupTokenCeilingForModel(model: string): number {
  if (!isBriefingRealtime2Model(model)) {
    return CURRENT_REALTIME_STARTUP_TOKEN_CEILING;
  }

  return (
    REALTIME2_CONTEXT_WINDOW_TOKENS -
    BRIEFING_REALTIME_OUTPUT_TOKEN_RESERVE -
    TOKEN_SAFETY_MARGIN
  );
}

function postInstructionTokenLimitForModel({
  model,
  estimatedStartupTokens,
}: {
  model: string;
  estimatedStartupTokens?: number;
}): number {
  if (!isBriefingRealtime2Model(model)) {
    return CURRENT_REALTIME_STARTUP_TOKEN_CEILING;
  }

  if (typeof estimatedStartupTokens !== "number") {
    return FALLBACK_REALTIME2_POST_INSTRUCTIONS_TOKENS;
  }

  return Math.max(
    BRIEFING_REALTIME_OUTPUT_TOKEN_RESERVE,
    REALTIME2_CONTEXT_WINDOW_TOKENS -
      estimatedStartupTokens -
      BRIEFING_REALTIME_OUTPUT_TOKEN_RESERVE -
      TOKEN_SAFETY_MARGIN,
  );
}

function buildTurnDetectionConfig(model: string) {
  if (isBriefingRealtime2Model(model)) {
    return {
      type: "semantic_vad",
      eagerness: "low",
      create_response: true,
      interrupt_response: true,
    };
  }

  return {
    type: "server_vad",
    create_response: true,
    interrupt_response: true,
    prefix_padding_ms: 300,
    silence_duration_ms: 500,
    threshold: 0.5,
  };
}

function buildOpenAiSafetyIdentifier(clientIpHash: string): string {
  return clientIpHash;
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const rawValue = process.env[name]?.trim();
  if (!rawValue) {
    return fallback;
  }

  const parsed = Number(rawValue);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function buildRealtimeCompactionConfig() {
  if (process.env.BRIEFING_REALTIME_COMPACTION_ENABLED !== "true") {
    return null;
  }

  return {
    enabled: true,
    triggerInputTokens: readPositiveIntegerEnv(
      "BRIEFING_REALTIME_COMPACTION_TRIGGER_INPUT_TOKENS",
      DEFAULT_REALTIME_COMPACTION_TRIGGER_INPUT_TOKENS,
    ),
    keepRecentItemCount: readPositiveIntegerEnv(
      "BRIEFING_REALTIME_COMPACTION_KEEP_RECENT_ITEMS",
      DEFAULT_REALTIME_COMPACTION_KEEP_RECENT_ITEMS,
    ),
    minDeleteItemCount: readPositiveIntegerEnv(
      "BRIEFING_REALTIME_COMPACTION_MIN_DELETE_ITEMS",
      DEFAULT_REALTIME_COMPACTION_MIN_DELETE_ITEMS,
    ),
  };
}

function buildRealtimeSessionConfig({
  instructions,
  tools,
  model,
  postInstructionsTokenLimit,
}: {
  instructions: string;
  tools: unknown[];
  model: string;
  postInstructionsTokenLimit: number;
}) {
  return {
    type: "realtime",
    model,
    output_modalities: ["audio"],
    instructions,
    tools,
    tool_choice: "auto",
    max_output_tokens: BRIEFING_REALTIME_MAX_OUTPUT_TOKENS,
    ...(isBriefingRealtime2Model(model)
      ? { reasoning: { effort: "medium" } }
      : {}),
    audio: {
      input: {
        noise_reduction: { type: RECOMMENDED_INPUT_NOISE_REDUCTION },
        transcription: {
          model: "gpt-4o-mini-transcribe",
          language: "en",
          prompt:
            "AI company names, model names, paper titles, and author names are common.",
        },
        turn_detection: buildTurnDetectionConfig(model),
      },
      output: {
        voice: RECOMMENDED_VOICE,
      },
    },
    truncation: {
      type: "retention_ratio",
      retention_ratio: 0.8,
      token_limits: {
        post_instructions: postInstructionsTokenLimit,
      },
    },
  };
}

function hashPromptPayload(instructions: string, tools: unknown[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        instructions,
        tools,
      }),
    )
    .digest("hex");
}

function extractOpenAiCallId(locationHeader: string | null): string | null {
  if (!locationHeader) {
    return null;
  }

  const match = locationHeader.match(/\/v1\/realtime\/calls\/([^/?#]+)/);
  return match?.[1] ?? null;
}

async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);

  try {
    return await fetch(input, {
      ...init,
      signal: abortController.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function attemptOpenAiHangup(
  callId: string,
  apiKey: string,
  context: Record<string, unknown>,
): Promise<boolean> {
  try {
    const response = await fetchWithTimeout(
      `${OPENAI_REALTIME_CALLS_URL}/${encodeURIComponent(callId)}/hangup`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      },
      OPENAI_HANGUP_TIMEOUT_MS,
    );

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.error("briefing.call.cleanup_hangup_failed", {
        ...context,
        callId,
        status: response.status,
        body,
      });
      return false;
    }

    console.info("briefing.call.cleanup_hangup_succeeded", {
      ...context,
      callId,
    });
    return true;
  } catch (error) {
    console.error("briefing.call.cleanup_hangup_failed", {
      ...context,
      callId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

async function loadLatestDigest(): Promise<Digest | null> {
  const rows = (await sql`
    SELECT *
    FROM digests
    ORDER BY generated_at DESC
    LIMIT 1
  `) as Digest[];

  return rows[0] ?? null;
}

export async function POST(request: Request) {
  let requestBody: BriefingCallRequest | null = null;
  let cleanupCallId: string | null = null;

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

    const { clientIpHash } = deriveClientIpInfo(request.headers);
    const latestDigest = await loadLatestDigest();

    if (!latestDigest) {
      return jsonError("digest_unavailable", 500);
    }

    if (requestBody.digestId !== latestDigest.id) {
      return jsonError("stale_digest", 409, {
        latestDigestId: latestDigest.id,
        latestDigestGeneratedAt: latestDigest.generated_at,
      });
    }

    const rateLimit = await consumeRateLimit({
      headers: request.headers,
      routeKey: "briefing/call",
      limit: DEFAULT_BRIEFING_RATE_LIMITS.call,
    });

    if (!rateLimit.allowed) {
      return jsonError("rate_limited", 429);
    }

    const activeSessions = await countActiveBriefingSessions(clientIpHash);
    if (activeSessions >= MAX_ACTIVE_SESSIONS_PER_IP) {
      return jsonError("too_many_active_sessions", 429);
    }

    const sourceItems = await getBriefingSourceItems({
      digest: latestDigest,
    });
    const selectedModel = resolveBriefingRealtimeModel();
    const promptPayload = buildBriefingPromptPayload({
      digest: latestDigest,
      sourceItems,
      model: selectedModel,
    });

    if (!promptPayload.budget.withinHardCeiling) {
      return jsonError("prompt_budget_exceeded", 500);
    }

    const openAiApiKey = process.env.OPENAI_API_KEY;
    if (!openAiApiKey) {
      return jsonError("openai_not_configured", 500);
    }

    const tokenEstimate = await estimatePromptTokens({
      representation: buildPromptTokenCountRepresentation({
        instructions: promptPayload.instructions,
        tools: promptPayload.tools,
        model: selectedModel,
      }),
      apiKey: openAiApiKey,
      timeoutMs: TOKEN_COUNT_TIMEOUT_MS,
    });

    let estimatedStartupTokens: number | undefined;
    if (tokenEstimate.available) {
      estimatedStartupTokens = tokenEstimate.inputTokens;
      if (
        tokenEstimate.inputTokens + TOKEN_SAFETY_MARGIN >
        startupTokenCeilingForModel(selectedModel)
      ) {
        return jsonError("prompt_token_budget_exceeded", 500);
      }
    } else {
      console.info("briefing.call.token_estimate_unavailable", {
        digestId: latestDigest.id,
        reason: tokenEstimate.reason,
        status: tokenEstimate.status ?? null,
      });
    }

    const sessionConfig = buildRealtimeSessionConfig({
      instructions: promptPayload.instructions,
      tools: promptPayload.tools,
      model: selectedModel,
      postInstructionsTokenLimit: postInstructionTokenLimitForModel({
        model: selectedModel,
        estimatedStartupTokens,
      }),
    });

    // Step 1: Create a client secret with session config
    const secretResponse = await fetchWithTimeout(
      OPENAI_CLIENT_SECRETS_URL,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openAiApiKey}`,
          "Content-Type": "application/json",
          "OpenAI-Safety-Identifier": buildOpenAiSafetyIdentifier(clientIpHash),
        },
        body: JSON.stringify({ session: sessionConfig }),
      },
      OPENAI_CREATE_CALL_TIMEOUT_MS,
    );

    if (!secretResponse.ok) {
      const body = await secretResponse.text().catch(() => "");
      console.error("briefing.call.openai_client_secret_failed", {
        digestId: latestDigest.id,
        status: secretResponse.status,
        body,
      });
      return jsonError("openai_call_failed", 502);
    }

    const secretJson = await secretResponse.json();
    const ephemeralKey = secretJson?.value as string | undefined;
    if (!ephemeralKey) {
      console.error("briefing.call.openai_client_secret_missing_key", {
        digestId: latestDigest.id,
      });
      return jsonError("openai_call_failed", 502);
    }

    // Step 2: Exchange SDP with ephemeral key
    const createCallResponse = await fetchWithTimeout(
      OPENAI_REALTIME_CALLS_URL,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ephemeralKey}`,
          "Content-Type": "application/sdp",
        },
        body: requestBody.sdp,
      },
      OPENAI_CREATE_CALL_TIMEOUT_MS,
    );

    cleanupCallId = createCallResponse.ok
      ? extractOpenAiCallId(createCallResponse.headers.get("location"))
      : null;

    const answerSdp = await createCallResponse.text();

    if (!createCallResponse.ok) {
      console.error("briefing.call.openai_create_failed", {
        digestId: latestDigest.id,
        status: createCallResponse.status,
        body: answerSdp,
      });
      return jsonError("openai_call_failed", 502);
    }

    if (!answerSdp.trim()) {
      throw new Error("OpenAI create-call returned an empty SDP answer");
    }

    const allowedSourceItemIds = promptPayload.digestItemManifest.items.map((item) => item.id);
    const sessionRecord = await createBriefingSession({
      digestId: latestDigest.id,
      sourceItemIds: allowedSourceItemIds,
      clientIpHash,
      openaiCallId: cleanupCallId,
      model: selectedModel,
      promptHash: hashPromptPayload(promptPayload.instructions, promptPayload.tools),
      promptBudgetJson: promptPayload.budget,
      maxActivePerIp: MAX_ACTIVE_SESSIONS_PER_IP,
    });

    if (!sessionRecord) {
      return jsonError("too_many_active_sessions", 429);
    }

    console.info("briefing.call.created", {
      briefingSessionId: sessionRecord.id,
      digestId: sessionRecord.digestId,
      openaiCallId: sessionRecord.openaiCallId,
      model: selectedModel,
      sourceItemCount: sessionRecord.sourceItemIds.length,
    });

    cleanupCallId = null;

    const compactionConfig = buildRealtimeCompactionConfig();

    return Response.json({
      answerSdp,
      briefingSessionId: sessionRecord.id,
      recommendedEndAt: sessionRecord.recommendedEndAt,
      ...(isBriefingObservabilityEnabled()
        ? { observabilityEnabled: true }
        : {}),
      ...(compactionConfig ? { compaction: compactionConfig } : {}),
    });
  } catch (error) {
    if (error instanceof MissingClientIpError) {
      return jsonError("missing_client_ip", 400);
    }

    if (cleanupCallId && process.env.OPENAI_API_KEY) {
      await attemptOpenAiHangup(cleanupCallId, process.env.OPENAI_API_KEY, {
        digestId: requestBody?.digestId ?? null,
      });
    }

    console.error("briefing.call.failed", {
      digestId: requestBody?.digestId ?? null,
      error: error instanceof Error ? error.message : String(error),
    });
    return jsonError("briefing_call_failed", 500);
  }
}
