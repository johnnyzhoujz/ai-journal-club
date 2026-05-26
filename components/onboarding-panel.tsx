"use client";

import { useSyncExternalStore } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

const STORAGE_KEY = "ai-journal-club:onboarding-dismissed";
const STORAGE_EVENT = "ai-journal-club:onboarding-storage";

const requiredItems = [
  {
    name: "Neon database",
    value: "DATABASE_URL / DATABASE_URL_UNPOOLED",
    detail:
      "Stores sources, fetched items, generated digests, paper evidence, and briefing memory. If you used Vercel's Neon integration, these may already be added to Vercel.",
  },
  {
    name: "Anthropic",
    value: "ANTHROPIC_API_KEY",
    detail: "Generates daily digests, research answers, deep dives, and synthesis.",
  },
  {
    name: "Cron protection",
    value: "CRON_SECRET",
    detail:
      "Protects scheduled worker endpoints. Add a generated random secret in Vercel; Vercel Cron sends it as a Bearer authorization header.",
  },
  {
    name: "App login",
    value: "AUTH_PASSWORD / AUTH_SESSION_SECRET",
    detail:
      "Sets the login password and signs session cookies. Use a generated random value for AUTH_SESSION_SECRET.",
  },
];

const optionalItems = [
  {
    name: "OpenAI",
    value: "OPENAI_API_KEY",
    detail:
      "Enables realtime audio briefings and optional embedding-based memory features.",
  },
  {
    name: "X API",
    value: "X_BEARER_TOKEN",
    detail: "Enables X post ingestion and public X profile lookup.",
  },
  {
    name: "Supadata",
    value: "SUPADATA_API_KEY",
    detail: "Enables YouTube and podcast transcript ingestion.",
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
            Add these as Vercel Environment Variables for the deployed project.
            After Vercel has the database URLs and secrets, pull the env locally
            and run the database setup before fetching content.
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

      <div className="mt-5">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Required
        </h3>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          {requiredItems.map((item) => (
            <CredentialItem key={item.value} item={item} />
          ))}
        </div>
      </div>

      <div className="my-5 border-t" />

      <div>
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Optional providers
        </h3>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          {optionalItems.map((item) => (
            <CredentialItem key={item.value} item={item} />
          ))}
        </div>
      </div>
    </section>
  );
}

function CredentialItem({
  item,
}: {
  item: { name: string; value: string; detail: string };
}) {
  return (
    <div className="rounded-md border p-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h4 className="text-sm font-semibold">{item.name}</h4>
        <code className="text-xs text-muted-foreground">{item.value}</code>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">{item.detail}</p>
    </div>
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
