import { sql } from "@/lib/db";
import type { FeedItem } from "@/lib/schema";

/**
 * Fetch source items for a digest. Uses stored IDs when available,
 * falls back to time-window heuristic for older digests without IDs.
 */
export async function getDigestSourceItems(
  sourceItemIds: number[],
  generatedAt: string,
): Promise<FeedItem[]> {
  // If we have stored IDs, use them directly
  if (sourceItemIds.length > 0) {
    return (await sql`
      SELECT id, source_type, title, content, url,
             author_name, author_handle, published_at,
             tweet_meta, paper_meta
      FROM feed_items
      WHERE id = ANY(${sourceItemIds})
      ORDER BY source_type, published_at DESC
    `) as FeedItem[];
  }

  // Fallback for old digests without stored IDs: replay time-window query
  const recentShort = (await sql`
    SELECT id, source_type, title, content, url,
           author_name, author_handle, published_at,
           tweet_meta, paper_meta
    FROM feed_items
    WHERE source_type IN ('tweet', 'paper')
    AND fetched_at > ${generatedAt}::timestamptz - INTERVAL '24 hours'
    AND fetched_at <= ${generatedAt}::timestamptz
    ORDER BY source_type, published_at DESC
  `) as FeedItem[];

  const recentLong = (await sql`
    SELECT id, source_type, title, content, url,
           author_name, author_handle, published_at,
           tweet_meta, paper_meta
    FROM feed_items
    WHERE source_type IN ('podcast', 'newsletter')
    AND fetched_at > ${generatedAt}::timestamptz - INTERVAL '72 hours'
    AND fetched_at <= ${generatedAt}::timestamptz
    ORDER BY source_type, published_at DESC
  `) as FeedItem[];

  return [...recentShort, ...recentLong];
}
