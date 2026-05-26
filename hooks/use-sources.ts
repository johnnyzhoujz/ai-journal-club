"use client";
import { useState, useEffect, useCallback } from "react";
import type { Source } from "@/lib/schema";

export interface SourcesData {
  x_accounts: Source[];
  podcasts: Source[];
  newsletters: Source[];
  papers: { enabled: boolean; id: number | null };
}

export function useSources() {
  const [data, setData] = useState<SourcesData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch("/api/sources");
        if (!res.ok) throw new Error("Failed to load sources");
        const json = await res.json();
        if (!cancelled) {
          setData(json);
          setError(null);
        }
      } catch {
        if (!cancelled) {
          setError("Failed to load sources");
          setData(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, []);

  const addSource = useCallback(async (body: Record<string, unknown>): Promise<boolean> => {
    try {
      const res = await fetch("/api/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const json = await res.json();
        setError(json.error || "Failed to add source");
        return false;
      }

      const created: Source = await res.json();
      setData((prev) => {
        if (!prev) return prev;
        switch (created.type) {
          case "x_account":
            return { ...prev, x_accounts: [...prev.x_accounts, created] };
          case "podcast":
            return { ...prev, podcasts: [...prev.podcasts, created] };
          case "newsletter":
            return { ...prev, newsletters: [...prev.newsletters, created] };
          case "papers":
            return { ...prev, papers: { enabled: true, id: created.id } };
          default:
            return prev;
        }
      });
      setError(null);
      return true;
    } catch {
      setError("Failed to add source");
      return false;
    }
  }, []);

  const removeSource = useCallback(async (id: number): Promise<boolean> => {
    try {
      const res = await fetch(`/api/sources?id=${id}`, { method: "DELETE" });

      if (!res.ok) {
        const json = await res.json();
        setError(json.error || "Failed to remove source");
        return false;
      }

      setData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          x_accounts: prev.x_accounts.filter((s) => s.id !== id),
          podcasts: prev.podcasts.filter((s) => s.id !== id),
          newsletters: prev.newsletters.filter((s) => s.id !== id),
          papers: prev.papers.id === id ? { enabled: false, id: null } : prev.papers,
        };
      });
      setError(null);
      return true;
    } catch {
      setError("Failed to remove source");
      return false;
    }
  }, []);

  const togglePapers = useCallback(async (): Promise<boolean> => {
    if (!data) return false;

    if (data.papers.enabled && data.papers.id) {
      return removeSource(data.papers.id);
    } else {
      return addSource({ type: "papers", name: "Hugging Face Daily Papers" });
    }
  }, [data, addSource, removeSource]);

  return { data, loading, error, addSource, removeSource, togglePapers };
}
