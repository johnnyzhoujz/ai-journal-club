import type { sql as sqlType } from "@/lib/db";
import type { FeedItemSourceType, PaperMeta, CorpusTier, PaperCorpusTierMetadata } from "@/lib/schema";

export interface PaperCorpusTierScoringReason {
  code: string;
  label: string;
  points: number;
  detail: string;
}

export interface PaperCorpusTierInput {
  title?: string | null;
  content?: string | null;
  publishedAt?: string | Date | null;
  paperMeta?: PaperMeta | null;
  tierMetadata?: PaperCorpusTierMetadata | null;
  referenceDate?: string | Date;
}

export interface PaperCorpusTierDecision {
  tier: CorpusTier;
  score: number;
  reasons: PaperCorpusTierScoringReason[];
  tierMetadata: PaperCorpusTierMetadata;
  scoredAt: string;
}

export interface PaperCorpusTierUpdatePayload {
  corpus_tier: CorpusTier;
  relevance_score: number;
  canon_score: number | null;
  hot_set_reason: string | null;
  canon_reason: string | null;
  archive_reason: string | null;
  ignored_reason: string | null;
  last_seen_at: string;
  last_scored_at: string;
  tier_metadata_json: PaperCorpusTierMetadata;
}

export interface PaperCorpusTierFeedItem {
  id: number;
  source_type: FeedItemSourceType;
  title: string | null;
  content: string;
  published_at: string | Date | null;
  paper_meta: PaperMeta | null;
  tier_metadata_json?: PaperCorpusTierMetadata | null;
}

export interface PaperCorpusTierPersistenceResult {
  decision: PaperCorpusTierDecision;
  updated: boolean;
}

export interface PaperIntakeTierPayload {
  corpus_tier: Extract<CorpusTier, "archive">;
  relevance_score: null;
  canon_score: null;
  hot_set_reason: null;
  canon_reason: null;
  archive_reason: string;
  ignored_reason: null;
  last_seen_at: string;
  last_scored_at: null;
  tier_metadata_json: PaperCorpusTierMetadata;
}

const VERSION = "v1";
export const PAPER_INTAKE_HOT_SET_GRACE_DAYS = 14;
export const PAPER_INTAKE_TIER_METADATA_VERSION = "intake-hot-set-v1";
const HOT_SET_THRESHOLD = 12;
const CORE_CANON_THRESHOLD = 7;

const HOT_TOPIC_TERMS = [
  ["agent", "agents"],
  ["benchmark", "benchmarks", "eval", "evaluation", "evaluations"],
  ["coding", "code", "programming", "software"],
  ["deep research", "research"],
  ["memory", "retrieval", "tool", "tools", "workflow", "workflows"],
  ["dataset", "datasets", "system", "systems", "method", "methods"],
  ["planning", "reasoning", "inference", "optimization"],
];

function toDate(value: string | Date | undefined): Date {
  if (!value) {
    return new Date();
  }
  return value instanceof Date ? value : new Date(value);
}

function safeIso(value: string | Date | undefined): string {
  return toDate(value).toISOString();
}

function dayDiff(referenceDate: Date, publishedAt?: string | Date | null): number | null {
  if (!publishedAt) {
    return null;
  }
  const published = publishedAt instanceof Date ? publishedAt : new Date(publishedAt);
  if (Number.isNaN(published.getTime())) {
    return null;
  }
  return Math.floor((referenceDate.getTime() - published.getTime()) / 86_400_000);
}

function pushReason(
  reasons: PaperCorpusTierScoringReason[],
  code: string,
  label: string,
  points: number,
  detail: string,
) {
  reasons.push({ code, label, points, detail });
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[‐‑‒–—]/g, "-")
    .replace(/[^a-z0-9@+.%\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsAny(haystack: string, needles: string[]): string[] {
  return needles.filter((needle) => haystack.includes(needle));
}

function scoreFreshness(referenceDate: Date, publishedAt?: string | Date | null) {
  const ageDays = dayDiff(referenceDate, publishedAt);
  if (ageDays == null) {
    return { points: 0, reason: null as PaperCorpusTierScoringReason | null };
  }
  if (ageDays <= 14) {
    return {
      points: 8,
      reason: {
        code: "freshness",
        label: "recent paper",
        points: 8,
        detail: `${ageDays} days old`,
      },
    };
  }
  if (ageDays <= 60) {
    return {
      points: 5,
      reason: {
        code: "freshness",
        label: "recent paper",
        points: 5,
        detail: `${ageDays} days old`,
      },
    };
  }
  if (ageDays <= 180) {
    return {
      points: 3,
      reason: {
        code: "freshness",
        label: "recent-ish paper",
        points: 3,
        detail: `${ageDays} days old`,
      },
    };
  }
  if (ageDays <= 365) {
    return {
      points: 1,
      reason: {
        code: "freshness",
        label: "prior-year paper",
        points: 1,
        detail: `${ageDays} days old`,
      },
    };
  }
  return {
    points: -1,
    reason: {
      code: "freshness",
      label: "stale paper",
      points: -1,
      detail: `${ageDays} days old`,
    },
  };
}

function scoreTextSignals(text: string, reasons: PaperCorpusTierScoringReason[]) {
  let score = 0;
  for (const group of HOT_TOPIC_TERMS) {
    const matched = containsAny(text, group);
    if (matched.length > 0) {
      const points = group.includes("agent") || group.includes("benchmark") ? 3 : 2;
      score += points;
      pushReason(
        reasons,
        `topic:${matched[0]}`,
        "topic match",
        points,
        `matched ${matched.join(", ")}`,
      );
    }
  }
  return score;
}

function scoreProviderSignals(paperMeta: PaperMeta | null | undefined, reasons: PaperCorpusTierScoringReason[]) {
  if (!paperMeta) {
    return 0;
  }
  let score = 0;
  if (paperMeta.upvotes > 0) {
    const points = Math.min(4, Math.floor(paperMeta.upvotes / 10) + 1);
    score += points;
    pushReason(reasons, "provider:upvotes", "HF upvotes", points, `${paperMeta.upvotes} upvotes`);
  }
  if (paperMeta.numComments > 0) {
    const points = Math.min(2, Math.floor(paperMeta.numComments / 5) + 1);
    score += points;
    pushReason(reasons, "provider:comments", "HF comments", points, `${paperMeta.numComments} comments`);
  }
  if (paperMeta.githubRepo) {
    score += 1;
    pushReason(reasons, "provider:github-repo", "code release", 1, paperMeta.githubRepo);
  }
  if ((paperMeta.githubStars ?? 0) > 0) {
    const points = Math.min(3, Math.floor((paperMeta.githubStars ?? 0) / 50) + 1);
    score += points;
    pushReason(
      reasons,
      "provider:github-stars",
      "GitHub stars",
      points,
      `${paperMeta.githubStars} stars`,
    );
  }
  if (paperMeta.aiSummary) {
    score += 1;
    pushReason(reasons, "provider:ai-summary", "AI summary", 1, "summary present");
  }
  if ((paperMeta.aiKeywords?.length ?? 0) > 0) {
    const points = Math.min(2, paperMeta.aiKeywords!.length >= 4 ? 2 : 1);
    score += points;
    pushReason(
      reasons,
      "provider:ai-keywords",
      "AI keywords",
      points,
      paperMeta.aiKeywords!.slice(0, 4).join(", "),
    );
  }
  return score;
}

function classifyScore(score: number): CorpusTier {
  if (score >= HOT_SET_THRESHOLD) {
    return "hot_set";
  }
  if (score >= CORE_CANON_THRESHOLD) {
    return "core_canon";
  }
  return "archive";
}

function applyManualOverrides(
  input: PaperCorpusTierInput,
  reasons: PaperCorpusTierScoringReason[],
): { tier: CorpusTier; score: number } | null {
  const metadata = input.tierMetadata;
  if (!metadata) {
    return null;
  }
  if (metadata.ignored) {
    pushReason(reasons, "override:ignored", "manual ignore", -100, "tier_metadata_json.ignored=true");
    return { tier: "ignored", score: -100 };
  }
  if (metadata.manualTier) {
    pushReason(
      reasons,
      "override:manual-tier",
      "manual tier",
      metadata.manualTier === "hot_set" ? 100 : metadata.manualTier === "core_canon" ? 50 : metadata.manualTier === "archive" ? 0 : -100,
      `tier_metadata_json.manualTier=${metadata.manualTier}`,
    );
    return { tier: metadata.manualTier, score: metadata.manualTier === "hot_set" ? 100 : metadata.manualTier === "core_canon" ? 50 : metadata.manualTier === "archive" ? 0 : -100 };
  }
  if (metadata.pinned) {
    pushReason(reasons, "override:pinned", "manual pin", 100, "tier_metadata_json.pinned=true");
    return { tier: "hot_set", score: 100 };
  }
  return null;
}

export function scorePaperCorpusTier(
  input: PaperCorpusTierInput,
): PaperCorpusTierDecision {
  const reasons: PaperCorpusTierScoringReason[] = [];
  const referenceDate = toDate(input.referenceDate);
  const override = applyManualOverrides(input, reasons);
  const scoredAt = safeIso(referenceDate);
  const tierMetadata: PaperCorpusTierMetadata = {
    scoreVersion: VERSION,
    ...(input.tierMetadata ?? {}),
  };

  if (override) {
    return {
      tier: override.tier,
      score: override.score,
      reasons,
      tierMetadata,
      scoredAt,
    };
  }

  const text = normalizeText(
    [input.title, input.content, input.paperMeta?.aiSummary, ...(input.paperMeta?.aiKeywords ?? [])]
      .filter((value): value is string => Boolean(value))
      .join(" "),
  );

  const freshness = scoreFreshness(referenceDate, input.publishedAt);
  if (freshness.reason) {
    reasons.push(freshness.reason);
  }

  let score = freshness.points;
  score += scoreTextSignals(text, reasons);
  score += scoreProviderSignals(input.paperMeta, reasons);

  const tier = classifyScore(score);
  return {
    tier,
    score,
    reasons,
    tierMetadata,
    scoredAt,
  };
}

export function buildPaperCorpusTierUpdatePayload(
  decision: PaperCorpusTierDecision,
  referenceDate: string | Date = decision.scoredAt,
): PaperCorpusTierUpdatePayload {
  const reasonText = decision.reasons.map((reason) => `${reason.label}: ${reason.detail}`).join("; ");
  const primaryReason = reasonText || null;
  return {
    corpus_tier: decision.tier,
    relevance_score: decision.score,
    canon_score: decision.tier === "core_canon" ? decision.score : null,
    hot_set_reason: decision.tier === "hot_set" ? primaryReason : null,
    canon_reason: decision.tier === "core_canon" ? primaryReason : null,
    archive_reason: decision.tier === "archive" ? primaryReason : null,
    ignored_reason: decision.tier === "ignored" ? primaryReason : null,
    last_seen_at: safeIso(referenceDate),
    last_scored_at: decision.scoredAt,
    tier_metadata_json: decision.tierMetadata,
  };
}

export function buildPaperIntakePendingHotSetPayload(
  referenceDate: string | Date = new Date(),
): PaperIntakeTierPayload {
  const selectedAt = safeIso(referenceDate);
  return {
    corpus_tier: "archive",
    relevance_score: null,
    canon_score: null,
    hot_set_reason: null,
    canon_reason: null,
    archive_reason: `new selected paper pending hot-set readiness (${PAPER_INTAKE_HOT_SET_GRACE_DAYS} day grace window)`,
    ignored_reason: null,
    last_seen_at: selectedAt,
    last_scored_at: null,
    tier_metadata_json: {
      scoreVersion: PAPER_INTAKE_TIER_METADATA_VERSION,
      retention: {
        intakeDefaultTier: "hot_set",
        graceDays: PAPER_INTAKE_HOT_SET_GRACE_DAYS,
        selectedAt,
        pendingTier: "hot_set",
        pendingSourceTier: "archive",
        pendingReviewAction: "intake_to_hot_set",
        pendingReviewStartedAt: selectedAt,
        pendingReviewReasons: [
          `new selected paper grace window (${PAPER_INTAKE_HOT_SET_GRACE_DAYS} days)`,
        ],
      },
    },
  };
}

export async function persistPaperCorpusTierMetadata(
  sqlClient: typeof sqlType,
  item: PaperCorpusTierFeedItem,
  referenceDate: string | Date = new Date(),
): Promise<PaperCorpusTierPersistenceResult> {
  if (item.source_type !== "paper") {
    const decision = scorePaperCorpusTier({
      title: item.title,
      content: item.content,
      publishedAt: item.published_at,
      paperMeta: item.paper_meta,
      tierMetadata: item.tier_metadata_json ?? undefined,
      referenceDate,
    });
    return { decision, updated: false };
  }

  const decision = scorePaperCorpusTier({
    title: item.title,
    content: item.content,
    publishedAt: item.published_at,
    paperMeta: item.paper_meta,
    tierMetadata: item.tier_metadata_json ?? undefined,
    referenceDate,
  });
  const payload = buildPaperCorpusTierUpdatePayload(decision, referenceDate);
  const updatedRows = (await sqlClient`
    UPDATE feed_items
    SET corpus_tier = ${payload.corpus_tier},
        relevance_score = ${payload.relevance_score},
        canon_score = ${payload.canon_score},
        hot_set_reason = ${payload.hot_set_reason},
        canon_reason = ${payload.canon_reason},
        archive_reason = ${payload.archive_reason},
        ignored_reason = ${payload.ignored_reason},
        last_seen_at = ${payload.last_seen_at},
        last_scored_at = ${payload.last_scored_at},
        tier_metadata_json = ${JSON.stringify(payload.tier_metadata_json)}
    WHERE id = ${item.id}
      AND source_type = 'paper'
    RETURNING id
  `) as Array<{ id: number }>;

  return { decision, updated: updatedRows.length > 0 };
}

export function summarizePaperCorpusTierDecision(decision: PaperCorpusTierDecision): string {
  const reason = decision.reasons[0];
  return reason
    ? `${decision.tier} (${decision.score}): ${reason.label} — ${reason.detail}`
    : `${decision.tier} (${decision.score})`;
}
