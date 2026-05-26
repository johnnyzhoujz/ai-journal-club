"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { Source, SourceType } from "@/lib/schema";

const EMPTY_MESSAGES: Record<string, string> = {
  x_account: "No X accounts added yet.",
  podcast: "No podcasts added yet.",
  newsletter: "No newsletters added yet.",
};

const PODCAST_TYPE_LABELS: Record<string, string> = {
  youtube_channel: "YouTube Channel",
  youtube_playlist: "YouTube Playlist",
};

function SourceDetail({ source }: { source: Source }) {
  switch (source.type) {
    case "x_account":
      return <span className="text-muted-foreground text-sm">@{source.handle}</span>;
    case "podcast":
      return (
        <span className="text-muted-foreground text-sm">
          {PODCAST_TYPE_LABELS[source.podcast_type ?? ""] ?? source.podcast_type}
        </span>
      );
    case "newsletter":
      return <span className="text-muted-foreground text-sm break-all">{source.feed_url}</span>;
    default:
      return null;
  }
}

interface SourceListProps {
  sources: Source[];
  onRemove: (id: number) => Promise<boolean>;
  type: SourceType;
}

export function SourceList({ sources, onRemove, type }: SourceListProps) {
  const [removingId, setRemovingId] = useState<number | null>(null);

  if (sources.length === 0) {
    return (
      <p className="text-muted-foreground text-sm py-8 text-center">
        {EMPTY_MESSAGES[type] ?? "No sources added yet."}
      </p>
    );
  }

  async function handleRemove(id: number) {
    setRemovingId(id);
    try {
      await onRemove(id);
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <ul className="divide-y divide-border">
      {sources.map((source) => (
        <li key={source.id} className="flex items-center justify-between py-3 gap-4">
          <div className="min-w-0 flex-1">
            <p className="font-medium text-sm">{source.name}</p>
            <SourceDetail source={source} />
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => handleRemove(source.id)}
            disabled={removingId === source.id}
            className="text-destructive hover:text-destructive hover:bg-destructive/10 shrink-0"
            aria-label={`Remove ${source.name}`}
          >
            {removingId === source.id ? "Removing..." : "Remove"}
          </Button>
        </li>
      ))}
    </ul>
  );
}
