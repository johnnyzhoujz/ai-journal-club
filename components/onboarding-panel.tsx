"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import { X } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "ai-journal-club:onboarding-dismissed";
const STORAGE_EVENT = "ai-journal-club:onboarding-storage";

const setupItems = [
  {
    name: "Neon database",
    value: "DATABASE_URL / DATABASE_URL_UNPOOLED",
    detail:
      "Stores sources, fetched items, generated digests, paper evidence, and briefing memory. Vercel's Neon integration can provision these automatically.",
  },
  {
    name: "Anthropic",
    value: "ANTHROPIC_API_KEY",
    detail: "Generates daily digests, research answers, deep dives, and synthesis.",
  },
  {
    name: "OpenAI",
    value: "OPENAI_API_KEY",
    detail:
      "Powers realtime audio briefings and optional embedding-based memory features.",
  },
  {
    name: "X API",
    value: "X_BEARER_TOKEN",
    detail: "Fetches X posts and detects public X profiles when adding sources.",
  },
  {
    name: "Supadata",
    value: "SUPADATA_API_KEY",
    detail: "Fetches YouTube and podcast transcripts for source ingestion.",
  },
  {
    name: "Cron protection",
    value: "CRON_SECRET",
    detail:
      "Protects scheduled worker endpoints. Vercel Cron sends it as a Bearer authorization header when configured.",
  },
  {
    name: "App login",
    value: "AUTH_PASSWORD / AUTH_SESSION_SECRET",
    detail: "Enables the simple password login and signed session cookies.",
  },
];

export function OnboardingPanel({ alwaysOpen = false }: { alwaysOpen?: boolean }) {
  const dismissed = useSyncExternalStore(
    subscribeToStorage,
    () => (alwaysOpen ? false : getDismissedSnapshot()),
    () => (alwaysOpen ? false : true),
  );

  function dismiss() {
    localStorage.setItem(STORAGE_KEY, "true");
    window.dispatchEvent(new Event(STORAGE_EVENT));
  }

  if (dismissed) {
    return null;
  }

  return (
    <section
      className="mb-8 rounded-lg border bg-card p-5 shadow-sm"
      aria-labelledby="setup-heading"
      data-testid="onboarding-panel"
    >
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-muted-foreground">First run</p>
          <h2 id="setup-heading" className="mt-1 text-2xl font-semibold">
            Connect your journal club workspace
          </h2>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
            Start with a clean Neon database, add the provider keys you want to
            use, then run the setup migration before fetching content.
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Dismiss setup"
          onClick={dismiss}
        >
          <X aria-hidden="true" />
        </Button>
      </div>

      <div className="mt-5 grid gap-3 md:grid-cols-2">
        {setupItems.map((item) => (
          <div key={item.value} className="rounded-md border p-3">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <h3 className="text-sm font-semibold">{item.name}</h3>
              <code className="text-xs text-muted-foreground">{item.value}</code>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">{item.detail}</p>
          </div>
        ))}
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        <Link href="/sources" className={cn(buttonVariants())}>
          Add sources
        </Link>
        <Link href="/setup" className={cn(buttonVariants({ variant: "outline" }))}>
          Open setup guide
        </Link>
      </div>
    </section>
  );
}

function getDismissedSnapshot() {
  if (typeof window === "undefined") {
    return true;
  }
  return localStorage.getItem(STORAGE_KEY) === "true";
}

function subscribeToStorage(callback: () => void) {
  if (typeof window === "undefined") {
    return () => {};
  }
  window.addEventListener("storage", callback);
  window.addEventListener(STORAGE_EVENT, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(STORAGE_EVENT, callback);
  };
}
