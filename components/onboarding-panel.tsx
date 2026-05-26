"use client";

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "ai-journal-club:onboarding-dismissed";
const STORAGE_EVENT = "ai-journal-club:onboarding-storage";
let generatedCronSecret: string | null = null;

const requiredItems = [
  {
    name: "Anthropic",
    value: "ANTHROPIC_API_KEY",
    detail: "Reads papers and populates the evidence used by digests and answers.",
  },
  {
    name: "OpenAI",
    value: "OPENAI_API_KEY",
    detail: "Powers the realtime voice agent and audio journal club experience.",
  },
  {
    name: "Cron protection",
    value: "CRON_SECRET",
    detail: "Protects the scheduled worker endpoints that fetch and process content.",
  },
  {
    name: "Login password",
    value: "AUTH_PASSWORD / AUTH_SESSION_SECRET",
    detail: "Sets the password you use to log into your own deployed app.",
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
    detail: "Enables YouTube, playlist, podcast, and transcript ingestion.",
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

  if (dismissed) {
    return null;
  }

  return (
    <section
      className="mb-8 rounded-lg border bg-card p-5 shadow-sm"
      aria-labelledby="setup-heading"
      data-testid="onboarding-panel"
    >
      <div>
        <div>
          <h2 id="setup-heading" className="mt-1 text-2xl font-semibold">
            Add your credentials in Vercel
          </h2>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
            After the first Vercel deployment creates your project and Neon
            database, add these under Environment Variables, then redeploy once.
            After that, sign in, wait for papers to populate, and listen to your
            journal club. You can add extra sources later, but you do not have to.
          </p>
        </div>
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
