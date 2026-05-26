"use client";

import { useSyncExternalStore } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

const STORAGE_KEY = "ai-journal-club:onboarding-dismissed";
const STORAGE_EVENT = "ai-journal-club:onboarding-storage";
let generatedCronSecret: string | null = null;

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
    name: "OpenAI",
    value: "OPENAI_API_KEY",
    detail:
      "Required for realtime audio briefings and embedding-backed memory features.",
  },
  {
    name: "Cron protection",
    value: "CRON_SECRET",
    detail:
      "Protects scheduled worker endpoints. Use the generated value below in Vercel; Vercel Cron sends it as a Bearer authorization header.",
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
  const cronSecret = useSyncExternalStore(
    subscribeToGeneratedSecret,
    getGeneratedCronSecretSnapshot,
    () => "",
  );
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
          <p className="text-sm font-medium text-muted-foreground">Setup</p>
          <h2 id="setup-heading" className="mt-1 text-2xl font-semibold">
            Add your credentials in Vercel
          </h2>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
            Add these under Environment Variables for this Vercel project. After
            Vercel has the Neon database URLs and required secrets, deployment
            runs the database setup automatically. Then sign in and add sources
            before fetching content.
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
            <CredentialItem
              key={item.value}
              item={item}
              generatedValue={item.value === "CRON_SECRET" ? cronSecret : undefined}
            />
          ))}
        </div>
      </div>

      <div className="my-5 border-t" />

      <div>
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Optional ingestion providers
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
  generatedValue,
}: {
  item: { name: string; value: string; detail: string };
  generatedValue?: string;
}) {
  return (
    <div className="rounded-md border p-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h4 className="text-sm font-semibold">{item.name}</h4>
        <code className="text-xs text-muted-foreground">{item.value}</code>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">{item.detail}</p>
      {generatedValue !== undefined ? (
        <div className="mt-3 rounded-md bg-muted p-2">
          <p className="text-xs font-medium text-muted-foreground">
            Generated value to paste into Vercel
          </p>
          <code className="mt-1 block break-all text-xs" data-testid="generated-cron-secret">
            {generatedValue || "Generating..."}
          </code>
        </div>
      ) : null}
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

function subscribeToGeneratedSecret() {
  return () => {};
}

function getGeneratedCronSecretSnapshot() {
  if (typeof window === "undefined") {
    return "";
  }
  generatedCronSecret ??= generateSecret("ajc_cron");
  return generatedCronSecret;
}

function generateSecret(prefix: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const bytes = new Uint8Array(48);
  const cryptoApi = globalThis.crypto;

  if (cryptoApi?.getRandomValues) {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }

  let secret = "";
  for (const byte of bytes) {
    secret += alphabet[byte & 63];
  }
  return `${prefix}_${secret}`;
}
