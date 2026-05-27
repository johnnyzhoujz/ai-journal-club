"use server";

import { generateDigestWithMetadata } from "@/lib/digest";
import { fetchAllContent, type FetchResult } from "@/lib/fetch-content";
import { sql } from "@/lib/db";
import {
  runHydratePapersWorker,
  type HydratePapersResult,
} from "@/app/api/hydrate-papers/route";
import {
  runEnrichPapersWorker,
  type EnrichPapersResult,
} from "@/app/api/enrich-papers/route";

export interface ManualPaperProcessingResult {
  hydrate: HydratePapersResult;
  enrich: EnrichPapersResult;
}

type FetchActionResult = FetchResult & {
  paperProcessing?: ManualPaperProcessingResult;
};

function digestUnavailableMessage(totalSkippedPapers: number) {
  if (totalSkippedPapers > 0) {
    return `${totalSkippedPapers} paper${totalSkippedPapers === 1 ? " is" : "s are"} still being processed before a digest can be generated.`;
  }
  return "No new content to digest";
}

export async function generateDigestAction(force?: boolean): Promise<
  | { content: string; item_count: number; tweet_count: number; podcast_count: number; newsletter_count: number; paper_count: number; model: string }
  | { message: string }
  | { error: string }
> {
  try {
    const generation = await generateDigestWithMetadata(undefined, force);
    const result = generation.digest;

    if (!result) {
      return { message: digestUnavailableMessage(generation.skippedPapers.total) };
    }

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

    return {
      content: result.content,
      item_count: result.itemCount,
      tweet_count: result.tweetCount,
      podcast_count: result.podcastCount,
      newsletter_count: result.newsletterCount,
      paper_count: result.paperCount,
      model: result.model,
    };
  } catch (err) {
    console.error("generateDigestAction failed:", err);
    return { error: "Failed to generate digest. Please try again." };
  }
}

async function runManualPaperProcessing(): Promise<ManualPaperProcessingResult> {
  const hydrate = await runHydratePapersWorker();
  const enrich = await runEnrichPapersWorker();
  return { hydrate, enrich };
}

export async function runFetchAction(): Promise<FetchActionResult | { error: string }> {
  try {
    const result = await fetchAllContent();
    if ((result.papers ?? 0) <= 0) {
      return result;
    }

    const paperProcessing = await runManualPaperProcessing();
    return { ...result, paperProcessing };
  } catch (err) {
    console.error("runFetchAction failed:", err);
    return { error: "Failed to fetch content. Please try again." };
  }
}
