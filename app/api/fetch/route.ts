import { NextRequest } from "next/server";
import { fetchAllContent } from "@/lib/fetch-content";
import { logCronFailure, logCronStart, logCronSuccess } from "@/lib/cron-logging";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  // Auth check
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return Response.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${cronSecret}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  logCronStart("fetch", request);

  try {
    const result = await fetchAllContent();
    logCronSuccess("fetch", request, startedAt, {
      tweets: result.tweets,
      podcasts: result.podcasts,
      newsletters: result.newsletters,
      papers: result.papers,
      errorCount: result.errors?.length ?? 0,
    });
    return Response.json(result);
  } catch (err) {
    logCronFailure("fetch", request, startedAt, err);
    return Response.json(
      { error: `Failed to fetch content: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }
}
