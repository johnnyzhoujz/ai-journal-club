"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { generateDigestAction, runFetchAction } from "@/app/actions";

export function DashboardActions() {
  const router = useRouter();
  const [digestLoading, setDigestLoading] = useState(false);
  const [fetchLoading, setFetchLoading] = useState(false);
  const [digestResult, setDigestResult] = useState<string | null>(null);
  const [fetchResult, setFetchResult] = useState<string | null>(null);

  async function handleGenerateDigest() {
    setDigestLoading(true);
    setDigestResult(null);
    try {
      const result = await generateDigestAction();
      if ("error" in result) {
        setDigestResult(result.error);
      } else if ("message" in result) {
        setDigestResult(result.message);
      } else {
        setDigestResult(
          `Digest generated! ${result.item_count} items processed.`,
        );
        router.refresh();
      }
    } catch {
      setDigestResult("An unexpected error occurred. Please try again.");
    } finally {
      setDigestLoading(false);
    }
  }

  async function handleRunFetch() {
    setFetchLoading(true);
    setFetchResult(null);
    try {
      const result = await runFetchAction();
      if ("error" in result) {
        setFetchResult(result.error);
      } else {
        const tweets = result.tweets || 0;
        const podcasts = result.podcasts || 0;
        const newsletters = result.newsletters || 0;
        const papers = result.papers || 0;
        const total = tweets + podcasts + newsletters + papers;

        const parts: string[] = [];
        if (tweets > 0) parts.push(`${tweets} tweets`);
        if (podcasts > 0) parts.push(`${podcasts} podcasts`);
        if (newsletters > 0) parts.push(`${newsletters} newsletters`);
        if (papers > 0)
          parts.push(`${papers} ${papers === 1 ? "paper" : "papers"}`);

        const processing = result.paperProcessing;
        const processingSummary = processing
          ? ` Hydrated ${processing.hydrate.succeeded} and enriched ${processing.enrich.succeeded} papers.`
          : "";
        const pendingSummary = processing &&
          (processing.hydrate.deadlineReached || processing.enrich.deadlineReached)
          ? " Processing is still catching up."
          : "";

        const summary =
          parts.length > 0
            ? `Fetched ${total} items (${parts.join(", ")}).${processingSummary}${pendingSummary}`
            : `Fetched 0 items`;
        setFetchResult(summary);
        router.refresh();
      }
    } catch {
      setFetchResult("An unexpected error occurred. Please try again.");
    } finally {
      setFetchLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-3">
        <Button onClick={handleGenerateDigest} disabled={digestLoading}>
          {digestLoading ? "Generating..." : "Generate Digest"}
        </Button>
        <Button
          variant="outline"
          onClick={handleRunFetch}
          disabled={fetchLoading}
        >
          {fetchLoading ? "Fetching..." : "Run Fetch Now"}
        </Button>
      </div>
      {digestResult && <p role="status">{digestResult}</p>}
      {fetchResult && <p role="status">{fetchResult}</p>}
    </div>
  );
}
