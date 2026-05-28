#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const DEFAULT_BASE_URL = "https://ai-journal-club-six.vercel.app";
const DEFAULT_FETCH_TIMEOUT_SECONDS = 290;
const DEFAULT_HYDRATE_LIMIT = 20;
const DEFAULT_HYDRATE_MAX_ROUNDS = 20;
const DEFAULT_HYDRATE_TIMEOUT_SECONDS = 290;
const DEFAULT_SEMANTIC_MAX_INVOCATIONS = 120;
const DEFAULT_SEMANTIC_TIMEOUT_SECONDS = 290;
const DEFAULT_SEMANTIC_IDLE_RETRIES = 3;
const DEFAULT_SEMANTIC_IDLE_SLEEP_SECONDS = 10;
const DEFAULT_DIGEST_TIMEOUT_SECONDS = 290;
const MAX_SUMMARY_ERRORS = 5;

function readInteger(
  name,
  fallback,
  { min = 0, max = Number.MAX_SAFE_INTEGER } = {},
  env = process.env,
) {
  const raw = env[name];
  if (raw == null || raw.trim() === "") {
    return fallback;
  }
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`${name} must be an integer`);
  }
  const value = Number.parseInt(raw, 10);
  if (value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

function readBoolean(name, fallback, env = process.env) {
  const raw = env[name];
  if (raw == null || raw.trim() === "") {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no"].includes(normalized)) {
    return false;
  }
  throw new Error(`${name} must be true or false`);
}

function summarizeErrors(errors) {
  if (!Array.isArray(errors)) {
    return {};
  }

  const countsByMessage = {};
  for (const entry of errors) {
    const message = typeof entry?.error === "string" ? entry.error : String(entry);
    countsByMessage[message] = (countsByMessage[message] ?? 0) + 1;
  }

  return {
    errorCount: errors.length,
    errors: errors.slice(0, MAX_SUMMARY_ERRORS),
    errorCountsByMessage: countsByMessage,
  };
}

function summarizeSkippedPapers(skippedPapers) {
  if (skippedPapers == null || typeof skippedPapers !== "object") {
    return skippedPapers;
  }

  return {
    total: skippedPapers.total ?? 0,
    ids: Array.isArray(skippedPapers.ids)
      ? skippedPapers.ids.slice(0, MAX_SUMMARY_ERRORS)
      : [],
    countsByDeterministicStatus: skippedPapers.countsByDeterministicStatus ?? {},
    countsBySemanticStatus: skippedPapers.countsBySemanticStatus ?? {},
    pendingIds: Array.isArray(skippedPapers.pendingIds)
      ? skippedPapers.pendingIds.slice(0, MAX_SUMMARY_ERRORS)
      : [],
    deadIds: Array.isArray(skippedPapers.deadIds)
      ? skippedPapers.deadIds.slice(0, MAX_SUMMARY_ERRORS)
      : [],
  };
}

function logDigestOutcome(body, { digestRequireReady }) {
  if (body == null || typeof body !== "object") {
    return;
  }

  const skippedPapers = summarizeSkippedPapers(body.skipped_papers);
  const skippedPaperCount =
    skippedPapers && typeof skippedPapers === "object"
      ? skippedPapers.total ?? 0
      : 0;
  const readyPaperCount =
    typeof body.paper_count === "number" ? body.paper_count : 0;
  const freshCandidateCount = readyPaperCount + skippedPaperCount;

  logEvent("digest_outcome", {
    digestRequireReady,
    freshCandidateCount,
    readyPaperCount,
    skippedPaperCount,
    skippedPaperIds:
      skippedPapers && typeof skippedPapers === "object"
        ? skippedPapers.ids ?? []
        : [],
    pendingPaperIds:
      skippedPapers && typeof skippedPapers === "object"
        ? skippedPapers.pendingIds ?? []
        : [],
    deadPaperIds:
      skippedPapers && typeof skippedPapers === "object"
        ? skippedPapers.deadIds ?? []
        : [],
    publishedWithSkippedPapers: Boolean(body.content) && skippedPaperCount > 0,
  });
}

export function summarizeRouteBody(body) {
  if (body == null || typeof body !== "object") {
    return body;
  }
  const keys = [
    "tweets",
    "podcasts",
    "newsletters",
    "papers",
    "paperLimit",
    "limitReached",
    "claimed",
    "succeeded",
    "failed",
    "dead",
    "noWork",
    "deadlineReached",
    "enabled",
    "skipped",
    "skipReason",
    "durationMs",
    "paper_count",
    "item_count",
    "message",
  ];
  const summary = Object.fromEntries(
    keys
      .filter((key) => Object.prototype.hasOwnProperty.call(body, key))
      .map((key) => [key, body[key]]),
  );
  Object.assign(summary, summarizeErrors(body.errors));
  if (Object.prototype.hasOwnProperty.call(body, "skipped_papers")) {
    summary.skipped_papers = summarizeSkippedPapers(body.skipped_papers);
  }
  return summary;
}

function logEvent(event, payload = {}) {
  console.log(JSON.stringify({ event, ...payload }));
}

function sleep(seconds) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

function makeRouteCaller({ baseUrl, cronSecret }) {
  return async function callRoute(path, { timeoutSeconds }) {
    const url = new URL(path, baseUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
    const startedAt = Date.now();

    try {
      logEvent("route_start", { path, timeoutSeconds });
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${cronSecret}`,
        },
        signal: controller.signal,
      });
      const text = await response.text();
      let body;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        throw new Error(`${path} returned non-JSON response: ${text.slice(0, 500)}`);
      }

      logEvent("route_response", {
        path,
        status: response.status,
        durationMs: Date.now() - startedAt,
        body: summarizeRouteBody(body),
      });

      if (!response.ok) {
        throw new Error(`${path} returned HTTP ${response.status}: ${text.slice(0, 500)}`);
      }
      return body;
    } finally {
      clearTimeout(timeout);
    }
  };
}

function validateClaimLimit(body, limit, routeName) {
  if (typeof body.claimed === "number" && body.claimed > limit) {
    throw new Error(`${routeName} claimed ${body.claimed} papers with limit ${limit}`);
  }
}

export async function drainHydration(callRoute, config) {
  const totals = {
    rounds: 0,
    claimed: 0,
    succeeded: 0,
    failed: 0,
    dead: 0,
  };

  for (let round = 1; round <= config.hydrateMaxRounds; round += 1) {
    totals.rounds = round;
    const body = await callRoute(`/api/hydrate-papers?limit=${config.hydrateLimit}`, {
      timeoutSeconds: config.hydrateTimeoutSeconds,
    });

    validateClaimLimit(body, config.hydrateLimit, "hydrate-papers");
    totals.claimed += body.claimed ?? 0;
    totals.succeeded += body.succeeded ?? 0;
    totals.failed += body.failed ?? 0;
    totals.dead += body.dead ?? 0;

    if (body.noWork === true) {
      logEvent("hydrate_drained", totals);
      return { drained: true, ...totals };
    }

    if ((body.claimed ?? 0) === 0 && body.deadlineReached === true) {
      throw new Error("hydrate-papers could not claim work because its internal deadline was already reached");
    }
  }

  logEvent("hydrate_not_drained", totals);
  return { drained: false, ...totals };
}

export async function drainSemantic(callRoute, config) {
  const totals = {
    invocations: 0,
    claimed: 0,
    succeeded: 0,
    failed: 0,
    dead: 0,
  };
  let idleCount = 0;

  for (let invocation = 1; invocation <= config.semanticMaxInvocations; invocation += 1) {
    totals.invocations = invocation;
    const body = await callRoute("/api/enrich-papers?limit=1", {
      timeoutSeconds: config.semanticTimeoutSeconds,
    });

    if (body.enabled === false || body.skipped === true) {
      logEvent("semantic_skipped", summarizeRouteBody(body));
      return {
        drained: false,
        skipped: true,
        skipReason: body.skipReason ?? "unknown",
        ...totals,
      };
    }

    validateClaimLimit(body, 1, "enrich-papers");
    totals.claimed += body.claimed ?? 0;
    totals.succeeded += body.succeeded ?? 0;
    totals.failed += body.failed ?? 0;
    totals.dead += body.dead ?? 0;

    if ((body.claimed ?? 0) === 0 && body.deadlineReached === true) {
      throw new Error("enrich-papers could not claim work because its internal deadline was already reached");
    }

    if (body.noWork === true) {
      idleCount += 1;
      logEvent("semantic_idle", {
        idleCount,
        idleRetries: config.semanticIdleRetries,
        ...totals,
      });
      if (idleCount >= config.semanticIdleRetries) {
        logEvent("semantic_drained", totals);
        return { drained: true, ...totals };
      }
      if (config.semanticIdleSleepSeconds > 0) {
        await sleep(config.semanticIdleSleepSeconds);
      }
    } else {
      idleCount = 0;
    }
  }

  logEvent("semantic_not_drained", totals);
  return { drained: false, ...totals };
}

export async function runPaperPipeline(callRoute, config) {
  logEvent("pipeline_start", {
    baseUrl: config.baseUrl,
    runFetch: config.runFetch,
    runDigest: config.runDigest,
    hydrateLimit: config.hydrateLimit,
    hydrateMaxRounds: config.hydrateMaxRounds,
    semanticMaxInvocations: config.semanticMaxInvocations,
    requireSemanticDrain: config.requireSemanticDrain,
    digestRequireReady: config.digestRequireReady,
  });

  let fetchResult = null;
  if (config.runFetch) {
    fetchResult = await callRoute("/api/fetch", {
      timeoutSeconds: config.fetchTimeoutSeconds,
    });
  }

  const hydrate = await drainHydration(callRoute, config);
  if (!hydrate.drained) {
    logEvent("hydrate_warning", {
      message: "deterministic hydration did not fully drain before digest",
      ...hydrate,
    });
  }

  let semantic = null;
  try {
    semantic = await drainSemantic(callRoute, config);
  } catch (error) {
    if (config.requireSemanticDrain) {
      throw error;
    }
    semantic = {
      drained: false,
      error: error instanceof Error ? error.message : String(error),
    };
    logEvent("semantic_warning", semantic);
  }

  if (semantic && !semantic.drained) {
    if (config.requireSemanticDrain) {
      throw new Error(
        `semantic enrichment did not drain after ${config.semanticMaxInvocations} invocations`,
      );
    }
    logEvent("semantic_not_drained_before_digest", {
      message: config.digestRequireReady
        ? "semantic enrichment did not fully drain; require-ready digest will block recent eligible papers that are not ready"
        : "semantic enrichment did not fully drain; digest will publish ready papers and report skipped blockers",
      ...semantic,
    });
  }

  let digest = null;
  if (config.runDigest) {
    const digestPath = config.digestRequireReady
      ? "/api/digest?requireReady=true"
      : "/api/digest";
    digest = await callRoute(digestPath, {
      timeoutSeconds: config.digestTimeoutSeconds,
    });
    logDigestOutcome(digest, {
      digestRequireReady: config.digestRequireReady,
    });
  }

  const result = {
    fetch: summarizeRouteBody(fetchResult),
    hydrate,
    semantic,
    digest: summarizeRouteBody(digest),
  };
  logEvent("pipeline_success", result);
  return result;
}

export function readPipelineConfig(env = process.env) {
  const cronSecret = env.CRON_SECRET;
  if (!cronSecret) {
    throw new Error("CRON_SECRET is required");
  }

  return {
    cronSecret,
    baseUrl:
      env.PAPER_PIPELINE_BASE_URL ||
      env.PAPER_WORKER_BASE_URL ||
      DEFAULT_BASE_URL,
    fetchTimeoutSeconds: readInteger(
      "PAPER_PIPELINE_FETCH_TIMEOUT_SECONDS",
      DEFAULT_FETCH_TIMEOUT_SECONDS,
      { min: 1, max: 290 },
      env,
    ),
    hydrateLimit: readInteger(
      "PAPER_PIPELINE_HYDRATE_LIMIT",
      DEFAULT_HYDRATE_LIMIT,
      { min: 1, max: 100 },
      env,
    ),
    hydrateMaxRounds: readInteger(
      "PAPER_PIPELINE_HYDRATE_MAX_ROUNDS",
      DEFAULT_HYDRATE_MAX_ROUNDS,
      { min: 1, max: 100 },
      env,
    ),
    hydrateTimeoutSeconds: readInteger(
      "PAPER_PIPELINE_HYDRATE_TIMEOUT_SECONDS",
      DEFAULT_HYDRATE_TIMEOUT_SECONDS,
      { min: 1, max: 290 },
      env,
    ),
    semanticMaxInvocations: readInteger(
      "PAPER_PIPELINE_SEMANTIC_MAX_INVOCATIONS",
      DEFAULT_SEMANTIC_MAX_INVOCATIONS,
      { min: 1, max: 200 },
      env,
    ),
    semanticTimeoutSeconds: readInteger(
      "PAPER_PIPELINE_SEMANTIC_TIMEOUT_SECONDS",
      DEFAULT_SEMANTIC_TIMEOUT_SECONDS,
      { min: 1, max: 290 },
      env,
    ),
    semanticIdleRetries: readInteger(
      "PAPER_PIPELINE_SEMANTIC_IDLE_RETRIES",
      DEFAULT_SEMANTIC_IDLE_RETRIES,
      { min: 1, max: 30 },
      env,
    ),
    semanticIdleSleepSeconds: readInteger(
      "PAPER_PIPELINE_SEMANTIC_IDLE_SLEEP_SECONDS",
      DEFAULT_SEMANTIC_IDLE_SLEEP_SECONDS,
      { min: 0, max: 600 },
      env,
    ),
    digestTimeoutSeconds: readInteger(
      "PAPER_PIPELINE_DIGEST_TIMEOUT_SECONDS",
      DEFAULT_DIGEST_TIMEOUT_SECONDS,
      { min: 1, max: 290 },
      env,
    ),
    runFetch: readBoolean("PAPER_PIPELINE_RUN_FETCH", true, env),
    runDigest: readBoolean("PAPER_PIPELINE_RUN_DIGEST", true, env),
    requireSemanticDrain: readBoolean(
      "PAPER_PIPELINE_REQUIRE_SEMANTIC_DRAIN",
      false,
      env,
    ),
    digestRequireReady: readBoolean("PAPER_PIPELINE_REQUIRE_DIGEST_READY", false, env),
  };
}

async function main() {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    throw new Error("CRON_SECRET is required");
  }

  const config = readPipelineConfig();

  const callRoute = makeRouteCaller({
    baseUrl: config.baseUrl,
    cronSecret,
  });

  await runPaperPipeline(callRoute, config);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    logEvent("pipeline_failure", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  });
}
