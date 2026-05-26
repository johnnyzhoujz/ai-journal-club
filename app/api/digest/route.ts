import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import {
  fetchSkippedDigestPapers,
  generateDigestWithMetadata,
} from "@/lib/digest";
import { logCronFailure, logCronStart, logCronSuccess } from "@/lib/cron-logging";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function parseBooleanParam(value: string | null): boolean {
  if (value === null) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export async function GET(request: NextRequest) {
  // Auth check
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

  // Optional model override from query param
  const model = request.nextUrl.searchParams.get("model") ?? undefined;
  const requireReady = parseBooleanParam(
    request.nextUrl.searchParams.get("requireReady"),
  );
  const startedAt = Date.now();
  logCronStart("digest", request, {
    requestedModel: model ?? null,
    requireReady,
  });

  try {
    if (requireReady) {
      const skippedPapers = await fetchSkippedDigestPapers();
      if (skippedPapers.total > 0) {
        const error = new Error(
          `Digest blocked because ${skippedPapers.total} recent paper(s) are not digest_ready`,
        );
        logCronFailure("digest", request, startedAt, error, {
          requestedModel: model ?? null,
          requireReady,
          skippedPaperCount: skippedPapers.total,
          skippedPaperIds: skippedPapers.ids,
          skippedPaperCountsByStatus: skippedPapers.countsByDeterministicStatus,
          skippedPaperCountsBySemanticStatus: skippedPapers.countsBySemanticStatus,
        });
        return Response.json(
          {
            error: error.message,
            skipped_papers: skippedPapers,
          },
          { status: 409 },
        );
      }
    }

    const generation = await generateDigestWithMetadata(model);
    const result = generation.digest;
    if (requireReady && generation.skippedPapers.total > 0) {
      const error = new Error(
        `Digest blocked because ${generation.skippedPapers.total} recent paper(s) are not digest_ready`,
      );
      logCronFailure("digest", request, startedAt, error, {
        requestedModel: model ?? null,
        requireReady,
        skippedPaperCount: generation.skippedPapers.total,
        skippedPaperIds: generation.skippedPapers.ids,
        skippedPaperCountsByStatus:
          generation.skippedPapers.countsByDeterministicStatus,
        skippedPaperCountsBySemanticStatus:
          generation.skippedPapers.countsBySemanticStatus,
      });
      return Response.json(
        {
          error: error.message,
          skipped_papers: generation.skippedPapers,
        },
        { status: 409 },
      );
    }

    if (generation.skippedPapers.total > 0) {
      console.info(
        JSON.stringify({
          event: "skipped_papers",
          job: "digest",
          skippedPaperCount: generation.skippedPapers.total,
          skippedPaperIds: generation.skippedPapers.ids,
          skippedPaperCountsByStatus:
            generation.skippedPapers.countsByDeterministicStatus,
          skippedPaperCountsBySemanticStatus:
            generation.skippedPapers.countsBySemanticStatus,
          pendingPaperIds: generation.skippedPapers.pendingIds,
          deadPaperIds: generation.skippedPapers.deadIds,
        }),
      );
    }

    if (!result) {
      logCronSuccess("digest", request, startedAt, {
        itemCount: 0,
        tweetCount: 0,
        podcastCount: 0,
        newsletterCount: 0,
        paperCount: 0,
        model: model ?? null,
        status: "no_content",
        requireReady,
        skippedPaperCount: generation.skippedPapers.total,
        skippedPaperIds: generation.skippedPapers.ids,
        skippedPaperCountsByStatus:
          generation.skippedPapers.countsByDeterministicStatus,
        skippedPaperCountsBySemanticStatus:
          generation.skippedPapers.countsBySemanticStatus,
      });
      return Response.json({
        message: "No new content to digest",
        skipped_papers: generation.skippedPapers,
      });
    }

    // Store in database
    await sql`
      INSERT INTO digests (content, item_count, tweet_count, podcast_count, newsletter_count, paper_count, source_item_ids, model)
      VALUES (
        ${result.content},
        ${result.itemCount},
        ${result.tweetCount},
        ${result.podcastCount},
        ${result.newsletterCount},
        ${result.paperCount},
        ${result.sourceItemIds},
        ${result.model}
      )
    `;

    logCronSuccess("digest", request, startedAt, {
      itemCount: result.itemCount,
      tweetCount: result.tweetCount,
      podcastCount: result.podcastCount,
      newsletterCount: result.newsletterCount,
      paperCount: result.paperCount,
      model: result.model,
      requireReady,
      skippedPaperCount: generation.skippedPapers.total,
      skippedPaperIds: generation.skippedPapers.ids,
      skippedPaperCountsByStatus:
        generation.skippedPapers.countsByDeterministicStatus,
      skippedPaperCountsBySemanticStatus:
        generation.skippedPapers.countsBySemanticStatus,
    });
    return Response.json({
      content: result.content,
      item_count: result.itemCount,
      tweet_count: result.tweetCount,
      podcast_count: result.podcastCount,
      newsletter_count: result.newsletterCount,
      paper_count: result.paperCount,
      model: result.model,
      skipped_papers: generation.skippedPapers,
    });
  } catch (err) {
    logCronFailure("digest", request, startedAt, err, {
      requestedModel: model ?? null,
      requireReady,
    });
    return Response.json(
      {
        error: `Digest generation failed: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 500 },
    );
  }
}
