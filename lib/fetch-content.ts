import { sql } from "@/lib/db";
import type {
  CorpusTier,
  FeedItemInsert,
  PaperCorpusTierMetadata,
  Source,
} from "@/lib/schema";
import { fetchXContent } from "@/lib/fetchers/x";
import { fetchYouTubeContent } from "@/lib/fetchers/youtube";
import { fetchRSSContent } from "@/lib/fetchers/rss";
import { fetchPapersContent } from "@/lib/fetchers/papers";
import { fetchAlphaxivContent } from "@/lib/fetchers/alphaxiv";
import {
  isMemoryChunkWritesEnabled,
  refreshKnowledgeChunksForFeedItemIfStale,
  type MemoryBackfillFeedItem,
} from "@/lib/memory-chunks";
import { buildPaperIntakeHotSetPayload } from "@/lib/paper-corpus-tiering";
import {
  ensurePaperProcessingStateForFeedItem,
  type PaperProcessingStateFeedItem,
} from "@/lib/paper-processing-state";

export interface FetchResult {
  tweets: number;
  podcasts: number;
  newsletters: number;
  papers: number;
  errors?: string[];
}

type UpsertedFeedItem = MemoryBackfillFeedItem &
  PaperProcessingStateFeedItem & {
    inserted: boolean;
    corpus_tier?: CorpusTier | null;
    tier_metadata_json?: PaperCorpusTierMetadata | null;
  };

function shouldRefreshKnowledgeChunksForUpsertedItem(item: UpsertedFeedItem) {
  if (item.source_type !== "paper") {
    return true;
  }

  const tierMetadata = item.tier_metadata_json ?? null;
  const manualTier = tierMetadata?.manualTier ?? null;
  if (
    tierMetadata?.ignored ||
    manualTier === "ignored" ||
    manualTier === "archive"
  ) {
    return false;
  }
  if (
    tierMetadata?.pinned ||
    manualTier === "hot_set" ||
    manualTier === "core_canon" ||
    tierMetadata?.retention?.pendingTier === "hot_set"
  ) {
    return true;
  }

  return item.corpus_tier === "hot_set" || item.corpus_tier === "core_canon";
}

export async function fetchAllContent(): Promise<FetchResult> {
  const sources = (await sql`SELECT * FROM sources WHERE active = TRUE`) as Source[];

  const xSources = sources.filter((s) => s.type === "x_account");
  const podcastSources = sources.filter((s) => s.type === "podcast");
  const newsletterSources = sources.filter((s) => s.type === "newsletter");
  const papersSources = sources.filter((s) => s.type === "papers");

  const counts = { tweets: 0, podcasts: 0, newsletters: 0, papers: 0 };
  const errors: string[] = [];

  type FetchTask = {
    key: keyof typeof counts;
    label: string;
    sourceId?: number;
    promise: Promise<FeedItemInsert[]>;
  };
  const tasks: FetchTask[] = [];

  if (xSources.length > 0) {
    tasks.push({
      key: "tweets",
      label: "tweets",
      promise: fetchXContent(xSources, process.env.X_BEARER_TOKEN!),
    });
  }
  if (podcastSources.length > 0) {
    tasks.push({
      key: "podcasts",
      label: "podcasts",
      promise: fetchYouTubeContent(podcastSources, process.env.SUPADATA_API_KEY!),
    });
  }
  if (newsletterSources.length > 0) {
    tasks.push({
      key: "newsletters",
      label: "newsletters",
      promise: fetchRSSContent(newsletterSources),
    });
  }
  for (const src of papersSources) {
    if (src.handle === "alphaxiv") {
      tasks.push({
        key: "papers",
        label: "papers:alphaxiv",
        sourceId: src.id,
        promise: fetchAlphaxivContent({ fetchFullText: false }),
      });
    } else {
      tasks.push({
        key: "papers",
        label: "papers:hf",
        sourceId: src.id,
        promise: fetchPapersContent({
          currentYearOnly: true,
          fetchFullText: false,
        }),
      });
    }
  }

  const settled = await Promise.allSettled(tasks.map((t) => t.promise));

  const allItems: FeedItemInsert[] = [];
  for (let i = 0; i < tasks.length; i++) {
    const result = settled[i];
    const task = tasks[i];
    if (result.status === "fulfilled") {
      const items = result.value.map((item) => ({
        ...item,
        source_id: item.source_id ?? task.sourceId ?? null,
      }));
      allItems.push(...items);
      counts[task.key] += items.length;
    } else {
      errors.push(
        `${task.label}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
      );
    }
  }

  const chunkWritesEnabled = isMemoryChunkWritesEnabled();

  for (const item of allItems) {
    let upsertedItems: UpsertedFeedItem[];

    try {
      const paperIntakeTier =
        item.source_type === "paper" ? buildPaperIntakeHotSetPayload() : null;
      upsertedItems = (await sql`
        INSERT INTO feed_items (
          source_type, external_id, source_id, title, content, url,
          author_name, author_handle, author_bio, published_at,
          tweet_meta, paper_meta, full_text, full_text_source,
          corpus_tier, relevance_score, canon_score, hot_set_reason,
          canon_reason, archive_reason, ignored_reason, last_seen_at,
          last_scored_at, tier_metadata_json
        ) VALUES (
          ${item.source_type},
          ${item.external_id},
          ${item.source_id ?? null},
          ${item.title ?? null},
          ${item.content},
          ${item.url},
          ${item.author_name},
          ${item.author_handle ?? null},
          ${item.author_bio ?? null},
          ${item.published_at ?? null},
          ${item.tweet_meta ? JSON.stringify(item.tweet_meta) : null},
          ${item.paper_meta ? JSON.stringify(item.paper_meta) : null},
          ${item.full_text ?? null},
          ${item.full_text_source ?? null},
          ${paperIntakeTier?.corpus_tier ?? "archive"},
          ${paperIntakeTier?.relevance_score ?? null},
          ${paperIntakeTier?.canon_score ?? null},
          ${paperIntakeTier?.hot_set_reason ?? null},
          ${paperIntakeTier?.canon_reason ?? null},
          ${paperIntakeTier?.archive_reason ?? null},
          ${paperIntakeTier?.ignored_reason ?? null},
          ${paperIntakeTier?.last_seen_at ?? null}::timestamptz,
          ${paperIntakeTier?.last_scored_at ?? null}::timestamptz,
          ${JSON.stringify(paperIntakeTier?.tier_metadata_json ?? {})}::jsonb
        )
        ON CONFLICT (source_type, external_id) DO UPDATE SET
          paper_meta = CASE
            WHEN EXCLUDED.paper_meta IS NULL THEN feed_items.paper_meta
            WHEN feed_items.paper_meta IS NULL THEN EXCLUDED.paper_meta
            ELSE jsonb_set(
              feed_items.paper_meta || (EXCLUDED.paper_meta - 'providers'),
              '{providers}',
              COALESCE(feed_items.paper_meta -> 'providers', '{}'::jsonb)
                || COALESCE(EXCLUDED.paper_meta -> 'providers', '{}'::jsonb)
            )
          END,
          full_text = CASE
            WHEN EXCLUDED.full_text IS NULL THEN feed_items.full_text
            WHEN feed_items.full_text IS NULL THEN EXCLUDED.full_text
            WHEN feed_items.full_text_source = 'hf_page'
              AND EXCLUDED.full_text_source = 'arxiv_html'
            THEN EXCLUDED.full_text
            ELSE feed_items.full_text
          END,
          full_text_source = CASE
            WHEN EXCLUDED.full_text IS NULL THEN feed_items.full_text_source
            WHEN feed_items.full_text IS NULL THEN EXCLUDED.full_text_source
            WHEN feed_items.full_text_source = 'hf_page'
              AND EXCLUDED.full_text_source = 'arxiv_html'
            THEN EXCLUDED.full_text_source
            ELSE feed_items.full_text_source
          END
        WHERE EXCLUDED.source_type = 'paper'
        RETURNING
          id,
          external_id,
          source_type,
          title,
          content,
          url,
          author_name,
          author_handle,
          published_at,
          paper_meta,
          full_text,
          full_text_source,
          corpus_tier,
          tier_metadata_json,
          (xmax = 0) AS inserted
      `) as UpsertedFeedItem[];
    } catch (err) {
      console.error(
        `Failed to insert item ${item.external_id}:`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }

    for (const upsertedItem of upsertedItems) {
      try {
        await ensurePaperProcessingStateForFeedItem(sql, upsertedItem);
      } catch (err) {
        console.error(
          `Failed to enqueue paper processing state for feed_item_id=${upsertedItem.id}:`,
          err instanceof Error ? err.message : err,
        );
      }

      if (!chunkWritesEnabled) {
        continue;
      }
      if (!shouldRefreshKnowledgeChunksForUpsertedItem(upsertedItem)) {
        continue;
      }

      try {
        await refreshKnowledgeChunksForFeedItemIfStale(upsertedItem);
      } catch (err) {
        console.error(
          `Failed to refresh memory chunks for feed_item_id=${upsertedItem.id}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  return {
    ...counts,
    ...(errors.length > 0 ? { errors } : {}),
  };
}
