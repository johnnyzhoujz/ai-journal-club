import type { Source } from "./schema";

let nextId = 10;

const SEED_DATA: Source[] = [
  { id: 1, type: "x_account", name: "Andrej Karpathy", handle: "karpathy", podcast_type: null, channel_handle: null, playlist_id: null, url: null, feed_url: null, created_at: "2026-01-15T00:00:00Z", active: true },
  { id: 2, type: "x_account", name: "Jim Fan", handle: "DrJimFan", podcast_type: null, channel_handle: null, playlist_id: null, url: null, feed_url: null, created_at: "2026-01-15T00:00:00Z", active: true },
  { id: 3, type: "podcast", name: "Lex Fridman Podcast", handle: null, podcast_type: "youtube_channel", channel_handle: "lexfridman", playlist_id: null, url: "https://youtube.com/@lexfridman", feed_url: null, created_at: "2026-01-15T00:00:00Z", active: true },
  { id: 4, type: "newsletter", name: "The Batch", handle: null, podcast_type: null, channel_handle: null, playlist_id: null, url: "https://www.deeplearning.ai/the-batch", feed_url: "https://www.deeplearning.ai/the-batch/feed", created_at: "2026-01-15T00:00:00Z", active: true },
  { id: 5, type: "papers", name: "Hugging Face Daily Papers", handle: null, podcast_type: null, channel_handle: null, playlist_id: null, url: null, feed_url: null, created_at: "2026-01-15T00:00:00Z", active: true },
];

let sources: Source[] = SEED_DATA.map((s) => ({ ...s }));

export function resetMockStore() {
  sources = SEED_DATA.map((s) => ({ ...s }));
  nextId = 10;
}

export function getMockSources(): Source[] {
  return sources.filter((s) => s.active);
}

export function addMockSource(body: Record<string, unknown>): Source {
  const handle = typeof body.handle === "string"
    ? (body.handle.startsWith("@") ? body.handle.slice(1) : body.handle)
    : null;

  const source: Source = {
    id: nextId++,
    type: body.type as Source["type"],
    name: body.name as string,
    handle,
    podcast_type: (body.podcast_type as Source["podcast_type"]) ?? null,
    channel_handle: (body.channel_handle as string) ?? null,
    playlist_id: (body.playlist_id as string) ?? null,
    url: (body.url as string) ?? null,
    feed_url: (body.feed_url as string) ?? null,
    created_at: new Date().toISOString(),
    active: true,
  };

  // Check for duplicates
  if (handle && sources.some((s) => s.handle === handle && s.active)) {
    throw Object.assign(new Error("duplicate"), { code: "23505" });
  }
  if (source.feed_url && sources.some((s) => s.feed_url === source.feed_url && s.active)) {
    throw Object.assign(new Error("duplicate"), { code: "23505" });
  }

  sources.push(source);
  return source;
}

export function removeMockSource(id: number): Source | null {
  const source = sources.find((s) => s.id === id && s.active);
  if (!source) return null;
  source.active = false;
  return source;
}
