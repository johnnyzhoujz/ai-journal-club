"use client";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { SourceType } from "@/lib/schema";

interface AddSourceFormProps {
  type: SourceType;
  onAdd: (body: Record<string, unknown>) => Promise<boolean>;
}

export function AddSourceForm({ type, onAdd }: AddSourceFormProps) {
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [podcastType, setPodcastType] = useState<"youtube_channel" | "youtube_playlist">("youtube_channel");
  const [url, setUrl] = useState("");
  const [channelHandle, setChannelHandle] = useState("");
  const [playlistId, setPlaylistId] = useState("");
  const [feedUrl, setFeedUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [detectingFeed, setDetectingFeed] = useState(false);
  const [detectingX, setDetectingX] = useState(false);
  const [detectingYoutube, setDetectingYoutube] = useState(false);

  function clearForm() {
    setName("");
    setHandle("");
    setPodcastType("youtube_channel");
    setUrl("");
    setChannelHandle("");
    setPlaylistId("");
    setFeedUrl("");
    setError(null);
  }

  function validate(): string | null {
    if (!name.trim()) return "Name is required";
    switch (type) {
      case "x_account":
        if (!handle.trim() || !handle.replace(/^@/, "").trim()) return "Handle is required";
        break;
      case "podcast":
        if (!url.trim()) return "URL is required";
        if (podcastType === "youtube_channel" && !channelHandle.trim()) return "Channel handle is required";
        if (podcastType === "youtube_playlist" && !playlistId.trim()) return "Playlist ID is required";
        break;
      case "newsletter":
        if (!feedUrl.trim()) return "Feed URL is required";
        break;
    }
    return null;
  }

  function buildPayload(): Record<string, unknown> {
    const base: Record<string, unknown> = { type, name: name.trim() };
    switch (type) {
      case "x_account":
        base.handle = handle.replace(/^@/, "").trim();
        break;
      case "podcast":
        base.podcast_type = podcastType;
        base.url = url.trim();
        if (podcastType === "youtube_channel") {
          base.channel_handle = channelHandle.trim();
        } else {
          base.playlist_id = playlistId.trim();
        }
        break;
      case "newsletter":
        base.url = url.trim();
        base.feed_url = feedUrl.trim();
        break;
    }
    return base;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    setSubmitting(true);
    try {
      const success = await onAdd(buildPayload());
      if (success) {
        clearForm();
      } else {
        setError("Failed to add source");
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDetectFeed() {
    if (!url.trim()) return;
    setDetectingFeed(true);
    setError(null);

    try {
      const res = await fetch("/api/detect-feed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });

      if (!res.ok) {
        const json = await res.json();
        setError(json.error || "Failed to detect feed");
        return;
      }

      const data = await res.json();
      setFeedUrl(data.feedUrl);
      if (data.name && !name.trim()) {
        setName(data.name);
      }
    } catch {
      setError("Failed to detect feed");
    } finally {
      setDetectingFeed(false);
    }
  }

  async function handleDetectXProfile() {
    if (!handle.trim()) return;
    setDetectingX(true);
    setError(null);

    try {
      const res = await fetch("/api/detect-x-profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle: handle.trim() }),
      });

      if (!res.ok) {
        const json = await res.json();
        setError(json.error || "Failed to detect profile");
        return;
      }

      const data = await res.json();
      if (data.name && !name.trim()) {
        setName(data.name);
      }
      if (data.handle) {
        setHandle(data.handle);
      }
    } catch {
      setError("Failed to detect profile");
    } finally {
      setDetectingX(false);
    }
  }

  async function handleDetectYoutube() {
    if (!url.trim()) return;
    setDetectingYoutube(true);
    setError(null);

    try {
      const res = await fetch("/api/detect-youtube", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });

      if (!res.ok) {
        const json = await res.json();
        setError(json.error || "Failed to detect YouTube info");
        return;
      }

      const data = await res.json();
      if (data.type) setPodcastType(data.type);
      if (data.channel_handle) setChannelHandle(data.channel_handle);
      if (data.playlist_id) setPlaylistId(data.playlist_id);
    } catch {
      setError("Failed to detect YouTube info");
    } finally {
      setDetectingYoutube(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4 mb-8">
      {type === "x_account" && (
        <div className="space-y-2">
          <Label htmlFor="x-handle">Handle</Label>
          <div className="flex gap-2">
            <Input
              id="x-handle"
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              placeholder="e.g. karpathy"
            />
            <Button
              type="button"
              variant="outline"
              onClick={handleDetectXProfile}
              disabled={!handle.trim() || detectingX}
            >
              {detectingX ? "Detecting..." : "Detect"}
            </Button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor={`${type}-name`}>Name</Label>
        <Input
          id={`${type}-name`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={type === "x_account" ? "e.g. Andrej Karpathy" : type === "podcast" ? "e.g. Lex Fridman Podcast" : "e.g. AI Weekly"}
        />
      </div>

      {type === "podcast" && (
        <>
          <div className="space-y-2">
            <Label htmlFor="podcast-url">YouTube URL</Label>
            <div className="flex gap-2">
              <Input
                id="podcast-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="e.g. https://youtube.com/@lexfridman"
              />
              <Button
                type="button"
                variant="outline"
                onClick={handleDetectYoutube}
                disabled={!url.trim() || detectingYoutube}
              >
                {detectingYoutube ? "Detecting..." : "Detect"}
              </Button>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="podcast-type">Type</Label>
            <select
              id="podcast-type"
              value={podcastType}
              onChange={(e) => setPodcastType(e.target.value as "youtube_channel" | "youtube_playlist")}
              className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 cursor-pointer"
            >
              <option value="youtube_channel">YouTube Channel</option>
              <option value="youtube_playlist">YouTube Playlist</option>
            </select>
          </div>
          {podcastType === "youtube_channel" ? (
            <div className="space-y-2">
              <Label htmlFor="channel-handle">Channel Handle</Label>
              <Input
                id="channel-handle"
                value={channelHandle}
                onChange={(e) => setChannelHandle(e.target.value)}
                placeholder="e.g. lexfridman"
              />
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="playlist-id">Playlist ID</Label>
              <Input
                id="playlist-id"
                value={playlistId}
                onChange={(e) => setPlaylistId(e.target.value)}
                placeholder="e.g. PL123abc"
              />
            </div>
          )}
        </>
      )}

      {type === "newsletter" && (
        <>
          <div className="space-y-2">
            <Label htmlFor="newsletter-url">URL</Label>
            <div className="flex gap-2">
              <Input
                id="newsletter-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="e.g. https://example.substack.com"
              />
              <Button
                type="button"
                variant="outline"
                onClick={handleDetectFeed}
                disabled={!url.trim() || detectingFeed}
              >
                {detectingFeed ? "Detecting..." : "Detect Feed"}
              </Button>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="feed-url">Feed URL</Label>
            <Input
              id="feed-url"
              value={feedUrl}
              onChange={(e) => setFeedUrl(e.target.value)}
              placeholder="e.g. https://example.substack.com/feed"
            />
          </div>
        </>
      )}

      {error && (
        <p className="text-destructive text-sm">{error}</p>
      )}

      <Button type="submit" disabled={submitting} className="self-start">
        {submitting ? "Adding..." : "Add Source"}
      </Button>
    </form>
  );
}
