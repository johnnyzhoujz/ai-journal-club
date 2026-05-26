import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };

describe("db setup script", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = {
      ...originalEnv,
      DATABASE_URL_UNPOOLED: "postgres://unpooled.example/testdb",
    };
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    vi.doUnmock("@neondatabase/serverless");
  });

  it("uses the Neon unpooled URL and applies migrations during deploy setup", async () => {
    const query = vi.fn(async (statement: string) => {
      if (statement.includes("SELECT COUNT(*)::int FROM feed_items")) {
        return [{ feed_items: 0, digests: 0 }];
      }
      return [];
    });
    const neon = vi.fn(() => ({ query }));

    vi.doMock("@neondatabase/serverless", () => ({ neon }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit(${code ?? ""})`);
    }) as never);

    await import("../db-setup");
    await waitFor(() =>
      query.mock.calls.some(([statement]) =>
        statement.includes("SELECT COUNT(*)::int FROM feed_items"),
      ),
    );

    expect(neon).toHaveBeenCalledWith("postgres://unpooled.example/testdb");
    expect(query.mock.calls.length).toBeGreaterThan(10);
  });
});

async function waitFor(assertion: () => boolean) {
  const start = Date.now();
  while (Date.now() - start < 1000) {
    if (assertion()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for db setup to finish");
}
