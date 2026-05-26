import type { Source, FeedItemInsert } from "../schema";

const SUPADATA_BASE = "https://api.supadata.ai/v1";
const PODCAST_LOOKBACK_HOURS = 72;

interface VideoCandidate {
  source: Source;
  videoId: string;
  title: string;
  publishedAt: string | null;
}

/**
 * Fetch recent podcast episodes from YouTube via Supadata API.
 * Preserves the expected transcript API request shape used by ingestion.
 * Dedup is handled by the DB constraint — no state parameter needed.
 */
export async function fetchYouTubeContent(
  sources: Source[],
  apiKey: string
): Promise<FeedItemInsert[]> {
  const cutoff = new Date(
    Date.now() - PODCAST_LOOKBACK_HOURS * 60 * 60 * 1000
  );
  const allCandidates: VideoCandidate[] = [];

  for (const source of sources) {
    try {
      let videosUrl: string;
      if (source.podcast_type === "youtube_playlist") {
        videosUrl = `${SUPADATA_BASE}/youtube/playlist/videos?id=${source.playlist_id}`;
      } else {
        videosUrl = `${SUPADATA_BASE}/youtube/channel/videos?id=${source.channel_handle}&type=video`;
      }

      const videosRes = await fetch(videosUrl, {
        headers: { "x-api-key": apiKey },
      });

      if (!videosRes.ok) {
        console.error(
          `YouTube: Failed to fetch videos for ${source.name}: HTTP ${videosRes.status}`
        );
        continue;
      }

      const videosData = await videosRes.json();
      const videoIds: string[] =
        videosData.videoIds || videosData.video_ids || [];

      // Check first 2 videos per channel
      for (const videoId of videoIds.slice(0, 2)) {
        try {
          const metaRes = await fetch(
            `${SUPADATA_BASE}/youtube/video?id=${videoId}`,
            { headers: { "x-api-key": apiKey } }
          );
          if (!metaRes.ok) continue;

          const meta = await metaRes.json();
          const publishedAt =
            meta.uploadDate || meta.publishedAt || meta.date || null;

          allCandidates.push({
            source,
            videoId,
            title: meta.title || "Untitled",
            publishedAt,
          });

          await new Promise((r) => setTimeout(r, 300));
        } catch (err) {
          console.error(
            `YouTube: Error fetching metadata for ${videoId}: ${err instanceof Error ? err.message : err}`
          );
        }
      }
    } catch (err) {
      console.error(
        `YouTube: Error processing ${source.name}: ${err instanceof Error ? err.message : err}`
      );
    }
  }

  // Pick 1 unseen video from the last 72 hours, oldest first
  const withinWindow = allCandidates
    .filter((v) => v.publishedAt && new Date(v.publishedAt) >= cutoff)
    .sort(
      (a, b) =>
        new Date(a.publishedAt!).getTime() -
        new Date(b.publishedAt!).getTime()
    );

  const selected = withinWindow[0];
  if (!selected) return [];

  // Fetch transcript
  try {
    const videoUrl = `https://www.youtube.com/watch?v=${selected.videoId}`;
    const transcriptRes = await fetch(
      `${SUPADATA_BASE}/youtube/transcript?url=${encodeURIComponent(videoUrl)}&text=true`,
      { headers: { "x-api-key": apiKey } }
    );

    if (!transcriptRes.ok) {
      console.error(
        `YouTube: Failed to get transcript for ${selected.videoId}: HTTP ${transcriptRes.status}`
      );
      return [];
    }

    const transcriptData = await transcriptRes.json();

    return [
      {
        source_type: "podcast" as const,
        external_id: selected.videoId,
        source_id: selected.source.id,
        title: selected.title,
        content: transcriptData.content || "",
        url: `https://youtube.com/watch?v=${selected.videoId}`,
        author_name: selected.source.name,
        published_at: selected.publishedAt,
      },
    ];
  } catch (err) {
    console.error(
      `YouTube: Error fetching transcript for ${selected.videoId}: ${err instanceof Error ? err.message : err}`
    );
    return [];
  }
}
