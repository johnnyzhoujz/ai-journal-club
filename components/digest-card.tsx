"use client";
import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Digest } from "@/lib/schema";
import { markdownComponents } from "@/lib/markdown-components";
import { formatDate, pluralize } from "@/lib/format";

interface DigestCardProps {
  digest: Digest;
}

export function DigestCard({ digest }: DigestCardProps) {
  const [expanded, setExpanded] = useState(false);

  const stats = [
    digest.tweet_count > 0 && pluralize(digest.tweet_count, "tweet"),
    digest.podcast_count > 0 && pluralize(digest.podcast_count, "podcast"),
    digest.newsletter_count > 0 && pluralize(digest.newsletter_count, "newsletter"),
    digest.paper_count > 0 && pluralize(digest.paper_count, "paper"),
  ].filter(Boolean);

  return (
    <div className="rounded-lg border border-border">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full text-left p-4 flex items-center justify-between gap-4"
      >
        <div className="min-w-0">
          <div className="font-medium">{formatDate(digest.generated_at)}</div>
          <div className="text-sm text-muted-foreground mt-1">
            {pluralize(digest.item_count, "item")}
            {stats.length > 0 && <span> · {stats.join(" · ")}</span>}
          </div>
        </div>
        {expanded ? (
          <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
      </button>
      {expanded && (
        <div
          data-testid="digest-content"
          className="text-sm px-4 pb-4 border-t border-border pt-4"
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
            {digest.content}
          </ReactMarkdown>
        </div>
      )}
    </div>
  );
}
