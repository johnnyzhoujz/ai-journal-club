import {
  closeBriefingSession,
  getBriefingSession,
} from "@/lib/briefing-session";
import { deriveClientIpInfo } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

const OPENAI_REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";
const OPENAI_HANGUP_TIMEOUT_MS = 5_000;

type EndRequestBody = {
  briefingSessionId: string;
};

function jsonError(error: string, status = 500) {
  return Response.json({ error }, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseRequestBody(value: unknown): EndRequestBody | null {
  if (!isRecord(value) || typeof value.briefingSessionId !== "string" || !value.briefingSessionId.trim()) {
    return null;
  }

  return {
    briefingSessionId: value.briefingSessionId,
  };
}

function buildSuccessPayload(session: {
  hangupAttemptedAt: string | null;
  hangupSucceededAt: string | null;
}) {
  const hangupAttempted = Boolean(session.hangupAttemptedAt);
  return {
    ok: true,
    closed: true,
    hangupAttempted,
    hangupSucceeded: hangupAttempted ? Boolean(session.hangupSucceededAt) : null,
  };
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

export async function POST(request: Request) {
  let requestBody: EndRequestBody | null = null;

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

    const session = await getBriefingSession(requestBody.briefingSessionId);
    if (!session) {
      return jsonError("invalid_session", 404);
    }

    let clientIpHash: string;

    try {
      clientIpHash = deriveClientIpInfo(request.headers).clientIpHash;
    } catch {
      return jsonError("invalid_session", 404);
    }

    if (session.clientIpHash !== clientIpHash) {
      return jsonError("invalid_session", 404);
    }

    if (session.closedAt) {
      return Response.json(buildSuccessPayload(session));
    }

    const now = new Date().toISOString();
    let hangupAttempted = false;
    let hangupSucceeded: boolean | null = null;

    if (session.openaiCallId && process.env.OPENAI_API_KEY) {
      hangupAttempted = true;

      try {
        const response = await fetchWithTimeout(
          `${OPENAI_REALTIME_CALLS_URL}/${encodeURIComponent(session.openaiCallId)}/hangup`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            },
          },
          OPENAI_HANGUP_TIMEOUT_MS,
        );

        hangupSucceeded = response.ok;

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          console.error("briefing.end.hangup_failed", {
            briefingSessionId: session.id,
            openaiCallId: session.openaiCallId,
            clientIpHash,
            status: response.status,
            body,
          });
        }
      } catch (error) {
        hangupSucceeded = false;
        console.error("briefing.end.hangup_failed", {
          briefingSessionId: session.id,
          openaiCallId: session.openaiCallId,
          clientIpHash,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } else if (session.openaiCallId) {
      console.warn("briefing.end.hangup_skipped", {
        briefingSessionId: session.id,
        openaiCallId: session.openaiCallId,
        clientIpHash,
        reason: "missing_openai_api_key",
      });
    } else {
      console.info("briefing.end.local_only", {
        briefingSessionId: session.id,
        clientIpHash,
      });
    }

    const closedSession = await closeBriefingSession({
      briefingSessionId: session.id,
      closedAt: now,
      hangupAttemptedAt: hangupAttempted ? now : null,
      hangupSucceededAt: hangupSucceeded ? now : null,
    });

    if (!closedSession) {
      return jsonError("invalid_session", 404);
    }

    console.info("briefing.end.closed", {
      briefingSessionId: closedSession.id,
      openaiCallId: closedSession.openaiCallId,
      clientIpHash,
      hangupAttempted,
      hangupSucceeded,
    });

    return Response.json({
      ok: true,
      closed: true,
      hangupAttempted,
      hangupSucceeded,
    });
  } catch (error) {
    console.error("briefing.end.failed", {
      briefingSessionId: requestBody?.briefingSessionId ?? null,
      error: error instanceof Error ? error.message : String(error),
    });
    return jsonError("briefing_end_failed", 500);
  }
}
