import { NextRequest } from "next/server";
import {
  backfillKnowledgeChunks,
  isMemoryChunkBackfillEnabled,
} from "@/lib/memory-chunks";
import { logCronFailure, logCronStart, logCronSuccess } from "@/lib/cron-logging";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_LIMIT = 100;
const MAX_CHUNKS_PER_ITEM = 100;

function parseOptionalPositiveInteger(
  searchParams: URLSearchParams,
  key: string,
  max?: number,
): number | null {
  const raw = searchParams.get(key);
  if (raw == null || raw === "") {
    return null;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }

  return max == null ? value : Math.min(value, max);
}

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return Response.json(
      { error: "CRON_SECRET not configured" },
      { status: 500 },
    );
  }

  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${cronSecret}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isMemoryChunkBackfillEnabled()) {
    return Response.json({
      enabled: false,
      featureFlag: "MEMORY_CHUNK_BACKFILL_ENABLED",
      message: "Memory chunk backfill is disabled",
    });
  }

  let options;
  try {
    const searchParams = request.nextUrl.searchParams;
    options = {
      limit: parseOptionalPositiveInteger(searchParams, "limit", MAX_LIMIT) ?? 25,
      afterId: parseOptionalPositiveInteger(searchParams, "afterId"),
      beforeId: parseOptionalPositiveInteger(searchParams, "beforeId"),
      feedItemId: parseOptionalPositiveInteger(searchParams, "feedItemId"),
      maxChunksPerItem:
        parseOptionalPositiveInteger(
          searchParams,
          "maxChunksPerItem",
          MAX_CHUNKS_PER_ITEM,
        ) ?? undefined,
      refreshExisting: searchParams.get("refresh") === "true",
    };
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }

  const startedAt = Date.now();
  logCronStart("memory-chunk-backfill", request, options);

  try {
    const result = await backfillKnowledgeChunks(options);

    logCronSuccess("memory-chunk-backfill", request, startedAt, { ...result });
    return Response.json({
      enabled: true,
      ...result,
    });
  } catch (error) {
    logCronFailure("memory-chunk-backfill", request, startedAt, error);
    return Response.json(
      {
        error: `Memory chunk backfill failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
      { status: 500 },
    );
  }
}
