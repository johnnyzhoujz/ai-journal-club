import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  drainHydration,
  drainSemantic,
  readPipelineConfig,
  runPaperPipeline,
  summarizeRouteBody,
} from "../run-paper-pipeline.mjs";

const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

function testConfig(overrides = {}) {
  return {
    baseUrl: "https://example.test",
    runFetch: true,
    runDigest: true,
    fetchTimeoutSeconds: 10,
    hydrateLimit: 20,
    hydrateMaxRounds: 1,
    hydrateTimeoutSeconds: 10,
    semanticMaxInvocations: 1,
    semanticTimeoutSeconds: 10,
    semanticIdleRetries: 1,
    semanticIdleSleepSeconds: 0,
    routeFailureLimit: 3,
    digestTimeoutSeconds: 10,
    requireSemanticDrain: false,
    digestRequireReady: false,
    ...overrides,
  };
}

describe("run-paper-pipeline", () => {
  beforeEach(() => {
    logSpy.mockClear();
  });

  it("publishes ready papers with skipped metadata after worker budget", async () => {
    const paths = [];
    const callRoute = vi.fn(async (path) => {
      paths.push(path);
      if (path === "/api/fetch") {
        return { papers: 20 };
      }
      if (path.startsWith("/api/hydrate-papers")) {
        return {
          claimed: 20,
          succeeded: 10,
          failed: 10,
          dead: 0,
          noWork: false,
        };
      }
      if (path === "/api/digest") {
        return {
          content: "stored digest",
          paper_count: 11,
          item_count: 11,
          skipped_papers: {
            total: 2,
            ids: [20, 21],
            rows: [],
            countsByDeterministicStatus: { failed: 2 },
            countsBySemanticStatus: { pending: 2 },
            pendingIds: [20, 21],
            deadIds: [],
          },
        };
      }
      if (path === "/api/enrich-papers?limit=1") {
        return {
          enabled: true,
          claimed: 0,
          succeeded: 0,
          failed: 0,
          dead: 0,
          noWork: true,
        };
      }
      throw new Error(`unexpected path ${path}`);
    });

    const result = await runPaperPipeline(callRoute, testConfig());

    expect(paths).toEqual([
      "/api/fetch",
      "/api/hydrate-papers?limit=20",
      "/api/enrich-papers?limit=1",
      "/api/digest",
    ]);
    expect(result.hydrate.drained).toBe(false);
    expect(result.digest.paper_count).toBe(11);
    const digestOutcome = logSpy.mock.calls
      .map((call) => JSON.parse(String(call[0])))
      .find((entry) => entry.event === "digest_outcome");
    expect(digestOutcome).toMatchObject({
      freshCandidateCount: 13,
      readyPaperCount: 11,
      skippedPaperCount: 2,
      skippedPaperIds: [20, 21],
      publishedWithSkippedPapers: true,
    });
  });

  it("runs non-blocking digest by default when semantic work does not fully drain", async () => {
    const callRoute = vi.fn(async (path) => {
      if (path === "/api/fetch") {
        return { papers: 1 };
      }
      if (path.startsWith("/api/hydrate-papers")) {
        return { claimed: 0, succeeded: 0, failed: 0, dead: 0, noWork: true };
      }
      if (path === "/api/digest") {
        return { message: "stored", paper_count: 1, item_count: 1 };
      }
      if (path === "/api/enrich-papers?limit=1") {
        return {
          enabled: true,
          claimed: 1,
          succeeded: 1,
          failed: 0,
          dead: 0,
          noWork: false,
        };
      }
      throw new Error(`unexpected path ${path}`);
    });

    const result = await runPaperPipeline(callRoute, testConfig());

    expect(result.semantic.drained).toBe(false);
    expect(result.digest.paper_count).toBe(1);
    expect(callRoute).toHaveBeenCalledWith(
      "/api/digest",
      expect.anything(),
    );
  });

  it("can opt into require-ready digest for pre-cutoff checks", async () => {
    const callRoute = vi.fn(async (path) => {
      if (path === "/api/fetch") {
        return { papers: 1 };
      }
      if (path.startsWith("/api/hydrate-papers")) {
        return { claimed: 0, succeeded: 0, failed: 0, dead: 0, noWork: true };
      }
      if (path === "/api/enrich-papers?limit=1") {
        return {
          enabled: true,
          claimed: 0,
          succeeded: 0,
          failed: 0,
          dead: 0,
          noWork: true,
        };
      }
      if (path === "/api/digest?requireReady=true") {
        return { message: "stored", paper_count: 1, item_count: 1 };
      }
      throw new Error(`unexpected path ${path}`);
    });

    const result = await runPaperPipeline(
      callRoute,
      testConfig({ digestRequireReady: true }),
    );

    expect(result.digest.paper_count).toBe(1);
    expect(callRoute).toHaveBeenCalledWith(
      "/api/digest?requireReady=true",
      expect.anything(),
    );
  });

  it("can require full semantic drain before digest when explicitly opted in", async () => {
    const callRoute = vi.fn(async (path) => {
      if (path === "/api/fetch") {
        return { papers: 1 };
      }
      if (path.startsWith("/api/hydrate-papers")) {
        return { claimed: 0, succeeded: 0, failed: 0, dead: 0, noWork: true };
      }
      if (path === "/api/enrich-papers?limit=1") {
        return {
          enabled: true,
          claimed: 1,
          succeeded: 1,
          failed: 0,
          dead: 0,
          noWork: false,
        };
      }
      throw new Error(`unexpected path ${path}`);
    });

    await expect(
      runPaperPipeline(callRoute, testConfig({ requireSemanticDrain: true })),
    ).rejects.toThrow("semantic enrichment did not drain");
    expect(callRoute).not.toHaveBeenCalledWith("/api/digest", expect.anything());
  });

  it("continues semantic drain after a recoverable route abort", async () => {
    const routeAbort = new Error("This operation was aborted");
    const callRoute = vi.fn()
      .mockResolvedValueOnce({
        enabled: true,
        claimed: 1,
        succeeded: 0,
        failed: 1,
        dead: 0,
        noWork: false,
      })
      .mockRejectedValueOnce(routeAbort)
      .mockResolvedValueOnce({
        enabled: true,
        claimed: 1,
        succeeded: 1,
        failed: 0,
        dead: 0,
        noWork: false,
      })
      .mockResolvedValueOnce({
        enabled: true,
        claimed: 0,
        succeeded: 0,
        failed: 0,
        dead: 0,
        noWork: true,
      });

    const result = await drainSemantic(
      callRoute,
      testConfig({ semanticMaxInvocations: 4 }),
    );

    expect(callRoute).toHaveBeenCalledTimes(4);
    expect(result).toMatchObject({
      drained: true,
      invocations: 4,
      claimed: 2,
      succeeded: 1,
      failed: 1,
      routeFailures: 1,
      consecutiveRouteFailures: 0,
      routeFailureLimitReached: false,
    });
    const routeError = logSpy.mock.calls
      .map((call) => JSON.parse(String(call[0])))
      .find((entry) => entry.event === "semantic_route_error");
    expect(routeError).toMatchObject({
      invocation: 2,
      routeFailures: 1,
      consecutiveRouteFailures: 1,
      routeFailureLimit: 3,
      error: "This operation was aborted",
    });
  });

  it("continues hydration drain after a recoverable route abort", async () => {
    const callRoute = vi.fn()
      .mockResolvedValueOnce({
        claimed: 20,
        succeeded: 20,
        failed: 0,
        dead: 0,
        noWork: false,
      })
      .mockRejectedValueOnce(new Error("This operation was aborted"))
      .mockResolvedValueOnce({
        claimed: 1,
        succeeded: 1,
        failed: 0,
        dead: 0,
        noWork: false,
      })
      .mockResolvedValueOnce({
        claimed: 0,
        succeeded: 0,
        failed: 0,
        dead: 0,
        noWork: true,
      });

    const result = await drainHydration(
      callRoute,
      testConfig({ hydrateMaxRounds: 4 }),
    );

    expect(callRoute).toHaveBeenCalledTimes(4);
    expect(result).toMatchObject({
      drained: true,
      rounds: 4,
      claimed: 21,
      succeeded: 21,
      failed: 0,
      routeFailures: 1,
      consecutiveRouteFailures: 0,
      routeFailureLimitReached: false,
    });
    const routeError = logSpy.mock.calls
      .map((call) => JSON.parse(String(call[0])))
      .find((entry) => entry.event === "hydrate_route_error");
    expect(routeError).toMatchObject({
      round: 2,
      routeFailures: 1,
      consecutiveRouteFailures: 1,
      routeFailureLimit: 3,
      error: "This operation was aborted",
    });
  });

  it("stops semantic drain quickly after consecutive route failures", async () => {
    const callRoute = vi.fn(async () => {
      throw new Error("This operation was aborted");
    });

    const result = await drainSemantic(
      callRoute,
      testConfig({ semanticMaxInvocations: 10, routeFailureLimit: 3 }),
    );

    expect(callRoute).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({
      drained: false,
      invocations: 3,
      claimed: 0,
      succeeded: 0,
      failed: 0,
      routeFailures: 3,
      consecutiveRouteFailures: 3,
      routeFailureLimitReached: true,
    });
    const limitLog = logSpy.mock.calls
      .map((call) => JSON.parse(String(call[0])))
      .find((entry) => entry.event === "semantic_route_failure_limit");
    expect(limitLog).toMatchObject({
      routeFailures: 3,
      consecutiveRouteFailures: 3,
      routeFailureLimit: 3,
    });
  });

  it("continues to digest when semantic is skipped", async () => {
    const callRoute = vi.fn(async (path) => {
      if (path === "/api/fetch") {
        return { papers: 1 };
      }
      if (path.startsWith("/api/hydrate-papers")) {
        return { claimed: 0, succeeded: 0, failed: 0, dead: 0, noWork: true };
      }
      if (path === "/api/digest") {
        return { message: "stored", paper_count: 1, item_count: 1 };
      }
      if (path === "/api/enrich-papers?limit=1") {
        return {
          enabled: false,
          skipped: true,
          skipReason: "disabled",
          claimed: 0,
          succeeded: 0,
          failed: 0,
          dead: 0,
          noWork: false,
        };
      }
      throw new Error(`unexpected path ${path}`);
    });

    const result = await runPaperPipeline(callRoute, testConfig());

    expect(result.semantic.drained).toBe(false);
    expect(result.semantic.skipped).toBe(true);
    expect(result.digest.paper_count).toBe(1);
  });

  it("summarizes route errors and skipped papers for durable logs", () => {
    expect(
      summarizeRouteBody({
        claimed: 2,
        errors: [
          { feedItemId: 1, error: "full text returned 429" },
          { feedItemId: 2, error: "full text returned 429" },
          { feedItemId: 3, error: "parser failed" },
        ],
        skipped_papers: {
          total: 2,
          ids: [10, 11],
          countsByDeterministicStatus: { pending: 1, dead: 1 },
          countsBySemanticStatus: { pending: 2 },
          pendingIds: [10],
          deadIds: [11],
        },
      }),
    ).toMatchObject({
      claimed: 2,
      errorCount: 3,
      errorCountsByMessage: {
        "full text returned 429": 2,
        "parser failed": 1,
      },
      skipped_papers: {
        total: 2,
        ids: [10, 11],
        countsByDeterministicStatus: { pending: 1, dead: 1 },
        countsBySemanticStatus: { pending: 2 },
      },
    });
  });

  it("defaults digest readiness to non-blocking and full semantic drain to non-fatal", () => {
    const config = readPipelineConfig({
      CRON_SECRET: "secret",
      PAPER_PIPELINE_SEMANTIC_MAX_INVOCATIONS: "2",
    });

    expect(config.requireSemanticDrain).toBe(false);
    expect(config.digestRequireReady).toBe(false);
    expect(config.semanticMaxInvocations).toBe(2);
    expect(config.routeFailureLimit).toBe(3);
  });

  it("can opt into requiring digest readiness from env", () => {
    const config = readPipelineConfig({
      CRON_SECRET: "secret",
      PAPER_PIPELINE_REQUIRE_DIGEST_READY: "true",
    });

    expect(config.digestRequireReady).toBe(true);
  });

  it("can opt into requiring full semantic drain from env", () => {
    const config = readPipelineConfig({
      CRON_SECRET: "secret",
      PAPER_PIPELINE_REQUIRE_SEMANTIC_DRAIN: "true",
    });

    expect(config.requireSemanticDrain).toBe(true);
  });
});
