"use server";

import { generateDigest } from "@/lib/digest";
import { fetchAllContent, type FetchResult } from "@/lib/fetch-content";
import { sql } from "@/lib/db";

export async function generateDigestAction(force?: boolean): Promise<
  | { content: string; item_count: number; tweet_count: number; podcast_count: number; newsletter_count: number; paper_count: number; model: string }
  | { message: string }
  | { error: string }
> {
  try {
    const result = await generateDigest(undefined, force);

    if (!result) {
      return { message: "No new content to digest" };
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

export async function runFetchAction(): Promise<FetchResult | { error: string }> {
  try {
    return await fetchAllContent();
  } catch (err) {
    console.error("runFetchAction failed:", err);
    return { error: "Failed to fetch content. Please try again." };
  }
}
