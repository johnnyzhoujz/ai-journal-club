import type { NextRequest } from "next/server";

export type CronJob =
  | "fetch"
  | "digest"
  | "memory-chunk-backfill"
  | "hydrate-papers"
  | "enrich-papers";

type WorkerLogLevel = "info" | "error";

interface WorkerLogDetails {
  event: string;
  feedItemId?: number | null;
  externalId?: string | null;
  phase: string;
  attempt?: number | null;
  durationMs?: number | null;
  timeRemainingMs?: number | null;
  status?: string | null;
  error?: unknown;
  [key: string]: unknown;
}

function normalizeError(error: unknown): string | null {
  if (error == null) {
    return null;
  }
  return error instanceof Error ? error.message : String(error);
}

function buildCronLogContext(job: CronJob, request: NextRequest) {
  return {
    job,
    timestamp: new Date().toISOString(),
    requestPath: request.nextUrl.pathname,
    vercelRequestId: request.headers.get("x-vercel-id") ?? undefined,
    deploymentId: process.env.VERCEL_DEPLOYMENT_ID ?? undefined,
  };
}

export function logCronStart(
  job: CronJob,
  request: NextRequest,
  details?: Record<string, unknown>,
) {
  console.info(
    JSON.stringify({
      event: "start",
      ...buildCronLogContext(job, request),
      ...details,
    }),
  );
}

export function logCronSuccess(
  job: CronJob,
  request: NextRequest,
  startedAt: number,
  details?: Record<string, unknown>,
) {
  console.info(
    JSON.stringify({
      event: "success",
      ...buildCronLogContext(job, request),
      durationMs: Date.now() - startedAt,
      ...details,
    }),
  );
}

export function logCronFailure(
  job: CronJob,
  request: NextRequest,
  startedAt: number,
  error: unknown,
  details?: Record<string, unknown>,
) {
  console.error(
    JSON.stringify({
      event: "failure",
      ...buildCronLogContext(job, request),
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      ...details,
    }),
  );
}

export function logWorkerEvent(
  job: CronJob,
  details: WorkerLogDetails,
  level: WorkerLogLevel = "info",
) {
  const {
    event,
    feedItemId,
    externalId,
    phase,
    attempt,
    durationMs,
    timeRemainingMs,
    status,
    error,
    ...rest
  } = details;
  const payload = {
    event,
    job,
    feedItemId: feedItemId ?? null,
    externalId: externalId ?? null,
    phase,
    attempt: attempt ?? null,
    durationMs: durationMs ?? null,
    timeRemainingMs: timeRemainingMs ?? null,
    status: status ?? null,
    error: normalizeError(error),
    ...rest,
  };
  const line = JSON.stringify(payload);
  if (level === "error") {
    console.error(line);
  } else {
    console.info(line);
  }
}
