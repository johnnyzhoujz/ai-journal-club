import fs from "fs";
import { describe, expect, it } from "vitest";

const FEATURE_DEFAULTS = [
  "PAPER_SEMANTIC_ENRICHMENT_ENABLED",
  "MEMORY_VECTOR_ENABLED",
  "MEMORY_CHUNK_WRITES_ENABLED",
  "MEMORY_READS_ENABLED",
  "PAPER_EVIDENCE_LAYER_ENABLED",
];

describe("Vercel deploy button", () => {
  it("requests Neon and keeps manual secrets out of the first deploy form", () => {
    const readme = fs.readFileSync("README.md", "utf-8");
    const href = readme.match(/href="([^"]*vercel\.com\/new\/clone[^"]*)"/)?.[1];

    expect(href).toBeTruthy();

    const url = new URL(href!);
    const products = JSON.parse(url.searchParams.get("products") ?? "[]");
    const envNames = (url.searchParams.get("env") ?? "")
      .split(",")
      .filter(Boolean);
    const envDefaults = JSON.parse(url.searchParams.get("envDefaults") ?? "{}");

    expect(url.searchParams.get("repository-url")).toBe(
      "https://github.com/johnnyzhoujz/ai-journal-club",
    );
    expect(products).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "integration",
          protocol: "storage",
          productSlug: "neon",
          integrationSlug: "neon",
        }),
      ]),
    );
    expect(envNames.sort()).toEqual([...FEATURE_DEFAULTS].sort());
    expect(Object.keys(envDefaults).sort()).toEqual([...FEATURE_DEFAULTS].sort());
    for (const key of FEATURE_DEFAULTS) {
      expect(envDefaults[key]).toBe("true");
    }
    expect(envNames).not.toEqual(
      expect.arrayContaining([
        "DATABASE_URL",
        "DATABASE_URL_UNPOOLED",
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "AUTH_PASSWORD",
        "AUTH_SESSION_SECRET",
        "CRON_SECRET",
        "X_BEARER_TOKEN",
        "SUPADATA_API_KEY",
      ]),
    );
  });
});
