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

type DigestActionResult =
  | {
      content: string;
      item_count: number;
      tweet_count: number;
      podcast_count: number;
      newsletter_count: number;
      paper_count: number;
      model: string;
      fetch?: FetchResult;
      paperProcessing?: ManualPaperProcessingResult;
    }
  | {
      message: string;
      fetch?: FetchResult;
      paperProcessing?: ManualPaperProcessingResult;
    }
  | { error: string };

function digestUnavailableMessage(totalSkippedPapers: number) {
  if (totalSkippedPapers > 0) {
    return `${totalSkippedPapers} paper${totalSkippedPapers === 1 ? " is" : "s are"} still being processed before a digest can be generated.`;
  }
  return "No new content to digest";
}

function fetchedItemCount(result: FetchResult) {
  return (
    (result.tweets ?? 0) +
    (result.podcasts ?? 0) +
    (result.newsletters ?? 0) +
    (result.papers ?? 0)
  );
}

function hasPaperProcessingActivity(processing: ManualPaperProcessingResult) {
  return (
    processing.hydrate.claimed > 0 ||
    processing.hydrate.succeeded > 0 ||
    processing.hydrate.failed > 0 ||
    processing.hydrate.dead > 0 ||
    processing.enrich.claimed > 0 ||
    processing.enrich.succeeded > 0 ||
    processing.enrich.failed > 0 ||
    processing.enrich.dead > 0
  );
}

async function storeDigestResult(
  result: NonNullable<Awaited<ReturnType<typeof generateDigestWithMetadata>>["digest"]>,
  extras: {
    fetch?: FetchResult;
    paperProcessing?: ManualPaperProcessingResult;
  } = {},
): Promise<DigestActionResult> {
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
    ...extras,
  };
}

async function prepareContentForDigest(
  skippedPaperCount: number,
): Promise<{
  fetch?: FetchResult;
  paperProcessing?: ManualPaperProcessingResult;
}> {
  if (skippedPaperCount > 0) {
    return { paperProcessing: await runManualPaperProcessing() };
  }

  const fetch = await fetchAllContent();
  if (fetchedItemCount(fetch) <= 0) {
    return {};
  }

  if ((fetch.papers ?? 0) <= 0) {
    return { fetch };
  }

  return {
    fetch,
    paperProcessing: await runManualPaperProcessing(),
  };
}

export async function generateDigestAction(force?: boolean): Promise<DigestActionResult> {
  try {
    let generation = await generateDigestWithMetadata(undefined, force);
    let result = generation.digest;

    if (result && (force || generation.skippedPapers.total === 0)) {
      return await storeDigestResult(result);
    }

    if (!force) {
      const extras = await prepareContentForDigest(generation.skippedPapers.total);
      if (extras.fetch || extras.paperProcessing) {
        generation = await generateDigestWithMetadata(undefined, force);
        result = generation.digest;
        if (result && generation.skippedPapers.total === 0) {
          return await storeDigestResult(result, extras);
        }
      }

      return {
        message: digestUnavailableMessage(generation.skippedPapers.total),
        ...extras,
      };
    }

    return { message: digestUnavailableMessage(generation.skippedPapers.total) };
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
    const paperProcessing = await runManualPaperProcessing();
    if ((result.papers ?? 0) <= 0 && !hasPaperProcessingActivity(paperProcessing)) {
      return result;
    }

    return { ...result, paperProcessing };
  } catch (err) {
    console.error("runFetchAction failed:", err);
    return { error: "Failed to fetch content. Please try again." };
  }
}
