"use client";
import { useState, useCallback, lazy, Suspense } from "react";
import { useRouter } from "next/navigation";
import { Sparkles, RefreshCw, Headphones } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Digest } from "@/lib/schema";
import { markdownComponents } from "@/lib/markdown-components";
import { formatDate, pluralize } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { generateDigestAction } from "@/app/actions";

const DeepDiveOverlay = lazy(() => import("./deep-dive/deep-dive-overlay"));
const BriefingOverlay = lazy(() => import("./briefing/briefing-overlay"));

interface DashboardDigestProps {
  digest: Digest;
}

export function DashboardDigest({ digest }: DashboardDigestProps) {
  const router = useRouter();
  const [deepDiveOpen, setDeepDiveOpen] = useState(false);
  const [briefingOpen, setBriefingOpen] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  const handleStaleDigest = useCallback(() => {
    setBriefingOpen(false);
    router.refresh();
  }, [router]);

  const handleSwitchToDeepDive = useCallback(() => {
    setBriefingOpen(false);
    setDeepDiveOpen(true);
  }, []);

  const stats = [
    digest.tweet_count > 0 && pluralize(digest.tweet_count, "tweet"),
    digest.podcast_count > 0 && pluralize(digest.podcast_count, "podcast"),
    digest.newsletter_count > 0 && pluralize(digest.newsletter_count, "newsletter"),
    digest.paper_count > 0 && pluralize(digest.paper_count, "paper"),
  ].filter(Boolean);

  return (
    <div className="rounded-lg border p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <p className="text-sm text-muted-foreground">
            Generated {formatDate(digest.generated_at)}
          </p>
          <p className="text-sm text-muted-foreground mt-1">
            {pluralize(digest.item_count, "item")}
            {stats.length > 0 && <span> · {stats.join(" · ")}</span>}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={regenerating}
            onClick={async () => {
              setRegenerating(true);
              try {
                const result = await generateDigestAction(true);
                if ("content" in result) {
                  router.refresh();
                }
              } finally {
                setRegenerating(false);
              }
            }}
          >
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${regenerating ? "animate-spin" : ""}`} />
            {regenerating ? "Regenerating..." : "Regenerate"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setBriefingOpen(true)}
            data-testid="start-briefing-button"
          >
            <Headphones className="h-3.5 w-3.5 mr-1.5" />
            Start Briefing
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setDeepDiveOpen(true)}
            data-testid="deep-dive-button"
          >
            <Sparkles className="h-3.5 w-3.5 mr-1.5" />
            Deep Dive
          </Button>
        </div>
      </div>
      <div className="text-sm">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
          {digest.content}
        </ReactMarkdown>
      </div>
      {deepDiveOpen && (
        <Suspense fallback={null}>
          <DeepDiveOverlay
            digest={digest}
            onClose={() => setDeepDiveOpen(false)}
          />
        </Suspense>
      )}
      {briefingOpen && (
        <Suspense fallback={null}>
          <BriefingOverlay
            digestId={digest.id}
            onClose={() => setBriefingOpen(false)}
            onStaleDigest={handleStaleDigest}
            onSwitchToDeepDive={handleSwitchToDeepDive}
          />
        </Suspense>
      )}
    </div>
  );
}
