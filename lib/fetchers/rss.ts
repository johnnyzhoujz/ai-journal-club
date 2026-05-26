import { XMLParser } from "fast-xml-parser";
import type { Source, FeedItemInsert } from "../schema";

const RSS_LOOKBACK_HOURS = 72;
const MAX_ARTICLES_PER_SOURCE = 3;

/**
 * Strip HTML tags and decode HTML entities (named and numeric).
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, dec) =>
      String.fromCharCode(parseInt(dec, 10))
    )
    .replace(/\s+/g, " ")
    .trim();
}

interface RSSLink {
  "@_href"?: string;
  "@_rel"?: string;
}

interface RSSItem {
  title?: string;
  link?: string | RSSLink | RSSLink[];
  pubDate?: string;
  published?: string;
  updated?: string;
  description?: string;
  "content:encoded"?: string;
  content?: string | { "#text"?: string };
  guid?: string | { "#text"?: string };
}

/**
 * Extract the link URL from an RSS/Atom item.
 * Handles: RSS string links, single Atom link objects, and Atom link arrays.
 */
function extractLink(item: RSSItem): string | null {
  if (typeof item.link === "string") return item.link;
  if (Array.isArray(item.link)) {
    const alt = item.link.find((l) => l["@_rel"] === "alternate");
    return (alt || item.link[0])?.["@_href"] || null;
  }
  if (item.link && typeof item.link === "object" && item.link["@_href"]) {
    return item.link["@_href"];
  }
  return null;
}

/**
 * Extract publication date from an RSS/Atom item.
 */
function extractDate(item: RSSItem): string | null {
  return item.pubDate || item.published || item.updated || null;
}

/**
 * Extract content/description from an RSS/Atom item.
 */
function extractContent(item: RSSItem): string {
  const raw =
    item["content:encoded"] ||
    item.description ||
    (typeof item.content === "string"
      ? item.content
      : item.content?.["#text"]) ||
    "";
  return stripHtml(String(raw));
}

/**
 * Fetch recent newsletter articles via RSS/Atom feeds.
 * Handles RSS 2.0 (<item>) and Atom (<entry>) formats.
 */
export async function fetchRSSContent(
  sources: Source[]
): Promise<FeedItemInsert[]> {
  const results: FeedItemInsert[] = [];
  const cutoff = new Date(
    Date.now() - RSS_LOOKBACK_HOURS * 60 * 60 * 1000
  );

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
  });

  for (const source of sources) {
    if (!source.feed_url) continue;

    try {
      const res = await fetch(source.feed_url);
      if (!res.ok) {
        console.error(
          `RSS: Failed to fetch ${source.name}: HTTP ${res.status}`
        );
        continue;
      }

      const xml = await res.text();
      const parsed = parser.parse(xml);

      // Handle RSS 2.0 and Atom formats
      let items: RSSItem[] = [];
      if (parsed.rss?.channel?.item) {
        const raw = parsed.rss.channel.item;
        items = Array.isArray(raw) ? raw : [raw];
      } else if (parsed.feed?.entry) {
        const raw = parsed.feed.entry;
        items = Array.isArray(raw) ? raw : [raw];
      }

      let count = 0;
      for (const item of items) {
        if (count >= MAX_ARTICLES_PER_SOURCE) break;

        const link = extractLink(item);
        if (!link) continue;

        const dateStr = extractDate(item);
        // Skip items without dates (can't verify recency) and items older than cutoff
        if (!dateStr || new Date(dateStr) < cutoff) continue;

        const content = extractContent(item);
        if (!content) continue;

        results.push({
          source_type: "newsletter",
          external_id: link,
          source_id: source.id,
          title: item.title ? String(item.title) : null,
          content,
          url: link,
          author_name: source.name,
          published_at: dateStr || null,
        });

        count++;
      }
    } catch (err) {
      console.error(
        `RSS: Error processing ${source.name}: ${err instanceof Error ? err.message : err}`
      );
    }
  }

  return results;
}
