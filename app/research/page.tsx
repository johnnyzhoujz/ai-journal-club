"use client";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { SearchResults } from "@/components/search-results";
import type { SearchResult } from "@/lib/schema";

export default function ResearchPage() {
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("all");
  const [after, setAfter] = useState("");
  const [before, setBefore] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [synthesis, setSynthesis] = useState<string | null>(null);
  const [synthesizing, setSynthesizing] = useState(false);

  const trimmedQuery = query.trim();
  const canSearch = trimmedQuery.length > 0 && !loading;

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!trimmedQuery) return;

    setLoading(true);
    setError(null);
    setResults(null);
    setSynthesis(null);

    try {
      const params = new URLSearchParams();
      params.set("q", trimmedQuery);
      params.set("source", source);
      if (after) params.set("after", after);
      if (before) params.set("before", before);

      const res = await fetch(`/api/search?${params.toString()}`);
      if (!res.ok) {
        throw new Error("Search failed");
      }
      const data = await res.json();
      setResults(data);
    } catch {
      setError("Search failed. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleSynthesize() {
    if (!results || results.length === 0) return;

    setSynthesizing(true);
    setError(null);

    try {
      const res = await fetch("/api/synthesize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: trimmedQuery, results }),
      });
      if (!res.ok) {
        throw new Error("Synthesis failed");
      }
      const data = await res.json();
      setSynthesis(data.synthesis);
    } catch {
      setError("Synthesis failed. Please try again.");
    } finally {
      setSynthesizing(false);
    }
  }

  return (
    <main className="w-full mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-bold mb-6">Research</h1>

      <form onSubmit={handleSearch} className="space-y-4 mb-8">
        <div>
          <Input
            placeholder="Search across all content..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div className="flex flex-wrap gap-4 items-end">
          <div>
            <Label htmlFor="source-filter">Source</Label>
            <select
              id="source-filter"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <option value="all">All</option>
              <option value="tweet">Tweet</option>
              <option value="podcast">Podcast</option>
              <option value="newsletter">Newsletter</option>
              <option value="paper">Paper</option>
            </select>
          </div>

          <div>
            <Label htmlFor="after-date">After</Label>
            <Input
              id="after-date"
              type="date"
              value={after}
              onChange={(e) => setAfter(e.target.value)}
            />
          </div>

          <div>
            <Label htmlFor="before-date">Before</Label>
            <Input
              id="before-date"
              type="date"
              value={before}
              onChange={(e) => setBefore(e.target.value)}
            />
          </div>

          <Button type="submit" disabled={!canSearch}>
            {loading ? "Searching..." : "Search"}
          </Button>
        </div>
      </form>

      {error && (
        <p className="text-destructive text-sm mb-4">{error}</p>
      )}

      {results !== null && !loading && (
        <>
          <SearchResults results={results} />
          {results.length > 0 && (
            <div className="mt-6">
              <Button
                variant="outline"
                onClick={handleSynthesize}
                disabled={synthesizing}
              >
                {synthesizing ? "Synthesizing..." : "Synthesize"}
              </Button>
            </div>
          )}
        </>
      )}

      {synthesis && (
        <div className="mt-6 rounded-lg border border-border p-4">
          <h2 className="font-medium mb-2">Synthesis</h2>
          <div className="whitespace-pre-wrap text-sm">{synthesis}</div>
        </div>
      )}
    </main>
  );
}
