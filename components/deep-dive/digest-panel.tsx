"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { markdownComponents } from "@/lib/markdown-components";
import { formatDate, pluralize } from "@/lib/format";
import type { Digest } from "@/lib/schema";

interface DigestPanelProps {
  digest: Digest;
}

export function DigestPanel({ digest }: DigestPanelProps) {
  const stats = [
    digest.tweet_count > 0 && pluralize(digest.tweet_count, "tweet"),
    digest.podcast_count > 0 && pluralize(digest.podcast_count, "podcast"),
    digest.newsletter_count > 0 && pluralize(digest.newsletter_count, "newsletter"),
    digest.paper_count > 0 && pluralize(digest.paper_count, "paper"),
  ].filter(Boolean);

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 py-4 border-b border-border shrink-0">
        <h2 className="text-lg font-semibold">{formatDate(digest.generated_at)}</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          {pluralize(digest.item_count, "item")}
          {stats.length > 0 && <span> · {stats.join(" · ")}</span>}
        </p>
      </div>
      <div className="flex-1 overflow-y-auto px-6 py-4">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={markdownComponents}
        >
          {digest.content}
        </ReactMarkdown>
      </div>
    </div>
  );
}
