import type { CorpusTier, PaperCorpusTierMetadata, PaperMeta } from "@/lib/schema";

export type PaperCorpusRefreshRow = {
  id: number;
  title: string | null;
  content: string;
  published_at: string | Date | null;
  paper_meta: PaperMeta | null;
  corpus_tier: CorpusTier;
  tier_metadata_json?: PaperCorpusTierMetadata | null;
};

export type PaperCorpusRefreshActionType = "promote" | "demote" | "keep";
export type PaperCorpusReviewGroup = "hot_set" | "core_canon" | "recent_archive" | "ignored";
export type PaperCorpusManualOverrideType = "ignored" | "manualTier" | "pinned" | "currentIgnoredTier";

export type PaperCorpusPopularitySnapshot = {
  hfUpvotes: number;
  hfComments: number;
  githubStars: number;
  githubRepo: string | null;
  reviewedAt: string | null;
};

export type PaperCorpusPopularityGrowth = {
  hfUpvotes: number;
  hfComments: number;
  githubStars: number;
  hasPriorSnapshot: boolean;
};

export type PaperCorpusReviewScoreComponents = {
  freshness: number;
  popularity: number;
  growth: number;
};

export type PaperCorpusManualOverride = {
  type: PaperCorpusManualOverrideType;
  recommendedTier: CorpusTier;
  detail: string;
};

export type PaperCorpusStorageTableName =
  | "feed_items"
  | "knowledge_chunks"
  | "paper_sections"
  | "paper_evidence_spans"
  | "paper_evidence_cards"
  | "paper_reader_profiles";

export type PaperCorpusStorageTableFootprint = {
  tableName: PaperCorpusStorageTableName;
  totalBytes: number;
  tableBytes: number;
  indexBytes: number;
};

export type PaperCorpusStorageTierFootprint = {
  tableName: PaperCorpusStorageTableName;
  tier: CorpusTier;
  rowCount: number;
  estimatedBytes: number;
};

export type PaperCorpusStoragePaperTableFootprint = {
  rowCount: number;
  estimatedBytes: number;
};

export type PaperCorpusStoragePaperFootprint = {
  id: number;
  title: string | null;
  currentTier: CorpusTier;
  rowCount: number;
  estimatedBytes: number;
  tables: Partial<Record<PaperCorpusStorageTableName, PaperCorpusStoragePaperTableFootprint>>;
};

export type PaperCorpusStorageFootprint = {
  tables: PaperCorpusStorageTableFootprint[];
  tiers: PaperCorpusStorageTierFootprint[];
  largestPapers: PaperCorpusStoragePaperFootprint[];
};

export const PAPER_CORPUS_ARCHIVE_PRUNE_TABLES = [
  "paper_evidence_cards",
  "paper_reader_profiles",
  "paper_evidence_spans",
  "paper_sections",
] as const satisfies readonly PaperCorpusStorageTableName[];

export type PaperCorpusArchivePruneTableName =
  (typeof PAPER_CORPUS_ARCHIVE_PRUNE_TABLES)[number];

export type PaperCorpusArchivePruneMode = "dry-run" | "execute";

export type PaperCorpusArchivePruneTableSummary = {
  tableName: PaperCorpusArchivePruneTableName;
  rowCount: number;
  estimatedBytes: number;
};

export type PaperCorpusArchivePruneCandidate = {
  id: number;
  title: string | null;
  currentTier: CorpusTier;
  rowCount: number;
  estimatedBytes: number;
  tables: Partial<Record<PaperCorpusArchivePruneTableName, PaperCorpusStoragePaperTableFootprint>>;
};

export type PaperCorpusArchivePruneProtectedPaper = {
  id: number;
  title: string | null;
  currentTier: CorpusTier;
  reason: string;
};

export type PaperCorpusArchivePrunePlan = {
  mode: PaperCorpusArchivePruneMode;
  generatedAt: string;
  prunedAt: string;
  candidateCount: number;
  candidateIds: number[];
  rowCount: number;
  estimatedReclaimableBytes: number;
  archiveRichEvidenceRowCount: number;
  archiveRichEvidenceEstimatedBytes: number;
  estimatedRemainingArchiveRichEvidenceBytes: number;
  tables: PaperCorpusArchivePruneTableSummary[];
  candidates: PaperCorpusArchivePruneCandidate[];
  protectedArchivePapers: PaperCorpusArchivePruneProtectedPaper[];
};

export type PaperCorpusArchivePrunePlanOptions = {
  mode?: PaperCorpusArchivePruneMode;
  generatedAt?: string | Date;
  prunedAt?: string | Date;
  storage?: PaperCorpusStorageFootprint | null;
  storageByFeedItemId?:
    | Map<number, PaperCorpusStoragePaperFootprint>
    | Record<number, PaperCorpusStoragePaperFootprint>
    | null;
};

export type PaperCorpusRefreshRecommendation = {
  id: number;
  currentTier: CorpusTier;
  recommendedTier: CorpusTier;
  action: PaperCorpusRefreshActionType;
  reviewGroup: PaperCorpusReviewGroup;
  score: number;
  scoreComponents: PaperCorpusReviewScoreComponents;
  popularity: PaperCorpusPopularitySnapshot;
  previousPopularity: PaperCorpusPopularitySnapshot | null;
  popularityGrowth: PaperCorpusPopularityGrowth;
  manualOverride: PaperCorpusManualOverride | null;
  summary: string;
  currentSummary: string;
  reasons: string[];
  ageDays: number | null;
  title: string | null;
  publishedAt: string | null;
};

export type PaperCorpusRefreshReport = {
  referenceDate: string;
  generatedAt: string;
  archiveLookbackDays: number;
  totalInputCount: number;
  totalCount: number;
  reviewedCount: number;
  skippedArchiveCount: number;
  keepCount: number;
  promoteCount: number;
  demoteCount: number;
  manualOverrideCount: number;
  currentTierCounts: Record<CorpusTier, number>;
  recommendedTierCounts: Record<CorpusTier, number>;
  hotSetRecommendations: PaperCorpusRefreshRecommendation[];
  coreCanonRecommendations: PaperCorpusRefreshRecommendation[];
  recentArchiveRecommendations: PaperCorpusRefreshRecommendation[];
  ignoredRecommendations: PaperCorpusRefreshRecommendation[];
  manualOverrides: PaperCorpusRefreshRecommendation[];
  promotions: PaperCorpusRefreshRecommendation[];
  demotions: PaperCorpusRefreshRecommendation[];
  keeps: PaperCorpusRefreshRecommendation[];
  storage: PaperCorpusStorageFootprint | null;
};

export type PaperCorpusReviewRunMode = "saved_review" | "execute_tier_updates";

export type PaperCorpusReviewRunSummary = {
  referenceDate: string;
  generatedAt: string;
  totalInputCount: number;
  reviewedCount: number;
  skippedArchiveCount: number;
  keepCount: number;
  promoteCount: number;
  demoteCount: number;
  manualOverrideCount: number;
  currentTierCounts: Record<CorpusTier, number>;
  recommendedTierCounts: Record<CorpusTier, number>;
};

export type PaperCorpusReviewItemSnapshot = {
  feedItemId: number;
  previousTier: CorpusTier;
  recommendedTier: CorpusTier;
  appliedTier: CorpusTier;
  action: PaperCorpusRefreshActionType;
  ageDays: number | null;
  score: number;
  freshnessScore: number;
  popularityScore: number;
  popularityGrowthScore: number;
  hfUpvotes: number;
  hfComments: number;
  githubStars: number;
  githubRepo: string | null;
  previousHfUpvotes: number | null;
  previousHfComments: number | null;
  previousGithubStars: number | null;
  reasons: string[];
  manualOverride: boolean;
  manualOverrideType: PaperCorpusManualOverrideType | null;
  manualOverrideDetail: string | null;
  popularity: PaperCorpusPopularitySnapshot;
  popularityGrowth: PaperCorpusPopularityGrowth;
  storage: PaperCorpusStoragePaperFootprint | null;
};

export type PaperCorpusReviewPersistenceSnapshot = {
  mode: PaperCorpusReviewRunMode;
  hotSetTarget: number;
  hotSetCap: number;
  coreCanonTarget: number;
  archiveLookbackDays: number;
  summary: PaperCorpusReviewRunSummary;
  items: PaperCorpusReviewItemSnapshot[];
};

export type PaperCorpusTierReviewUpdatePayload = {
  corpus_tier: CorpusTier;
  recommended_tier: CorpusTier;
  pending_hot_set_promotion: boolean;
  relevance_score: number;
  canon_score: number | null;
  hot_set_reason: string | null;
  canon_reason: string | null;
  archive_reason: string | null;
  ignored_reason: string | null;
  last_scored_at: string;
  tier_metadata_json: PaperCorpusTierMetadata;
};

export type PaperCorpusRefreshTextOptions = {
  sectionLimit?: number;
  modeLabel?: string;
};

export type PaperCorpusRefreshReportOptions = {
  referenceDate?: string | Date;
  archiveLookbackDays?: number;
  storage?: PaperCorpusStorageFootprint | null;
  previousPopularityByFeedItemId?:
    | Map<number, PaperCorpusPopularitySnapshot>
    | Record<number, PaperCorpusPopularitySnapshot>
    | null;
};

type NormalizedPaperCorpusRefreshReportOptions = {
  referenceDate: string | Date;
  archiveLookbackDays: number;
  storage: PaperCorpusStorageFootprint | null;
  previousPopularityByFeedItemId:
    | Map<number, PaperCorpusPopularitySnapshot>
    | Record<number, PaperCorpusPopularitySnapshot>
    | null;
};

type ScoredReview = {
  row: PaperCorpusRefreshRow;
  reviewGroup: PaperCorpusReviewGroup;
  recommendedTier: CorpusTier;
  score: number;
  scoreComponents: PaperCorpusReviewScoreComponents;
  popularity: PaperCorpusPopularitySnapshot;
  previousPopularity: PaperCorpusPopularitySnapshot | null;
  popularityGrowth: PaperCorpusPopularityGrowth;
  manualOverride: PaperCorpusManualOverride | null;
  reasons: string[];
};

const DEFAULT_ARCHIVE_LOOKBACK_DAYS = 90;
const HOT_SET_KEEP_SCORE = 35;
const HOT_SET_TO_CORE_SCORE = 18;
const CORE_CANON_KEEP_SCORE = 20;
const HOT_PROMOTION_SCORE = 65;
const HOT_PROMOTION_POPULARITY_SCORE = 45;
const HOT_PROMOTION_GROWTH_SCORE = 16;
const ARCHIVE_TO_CORE_POPULARITY_SCORE = 15;
const DEFAULT_HOT_SET_TARGET = 125;
const DEFAULT_HOT_SET_CAP = 200;
const DEFAULT_CORE_CANON_TARGET = 300;
const DAY_MS = 86_400_000;
const INTAKE_HOT_SET_GRACE_REASON = "intake Hot Set grace window preserved";

const TIER_RANK: Record<CorpusTier, number> = {
  hot_set: 3,
  core_canon: 2,
  archive: 1,
  ignored: 0,
};

function toDate(value: string | Date | null | undefined): Date | null {
  if (!value) {
    return null;
  }
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function ageDays(referenceDate: Date, publishedAt: string | Date | null | undefined): number | null {
  const date = toDate(publishedAt);
  if (!date) {
    return null;
  }
  return Math.floor((referenceDate.getTime() - date.getTime()) / DAY_MS);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function maxNumber(...values: unknown[]): number {
  return Math.max(0, ...values.map(asNumber));
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function metadataBoolean(value: unknown): boolean {
  return value === true || value === "true";
}

function retentionString(
  metadata: PaperCorpusTierMetadata | null | undefined,
  key: string,
): string | null {
  const retention = metadata?.retention;
  if (!retention) {
    return null;
  }
  return asString(retention[key]);
}

export function getPaperCorpusArchivePruneProtectionReason(
  row: PaperCorpusRefreshRow,
): string | null {
  const metadata = row.tier_metadata_json ?? null;
  const manualTier = asString(metadata?.manualTier);

  if (row.corpus_tier !== "archive") {
    return `current tier is ${row.corpus_tier}`;
  }
  if (metadataBoolean(metadata?.ignored)) {
    return "tier_metadata_json.ignored=true";
  }
  if (metadataBoolean(metadata?.pinned)) {
    return "tier_metadata_json.pinned=true";
  }
  if (manualTier) {
    return `manualTier=${manualTier}`;
  }
  if (retentionString(metadata, "pendingTier") === "hot_set") {
    return "pending Hot Set promotion";
  }

  return null;
}

export function isPaperCorpusArchivePruneEligible(row: PaperCorpusRefreshRow): boolean {
  return getPaperCorpusArchivePruneProtectionReason(row) === null;
}

function richEvidenceTableFootprints(
  paper: PaperCorpusStoragePaperFootprint | null,
): Partial<Record<PaperCorpusArchivePruneTableName, PaperCorpusStoragePaperTableFootprint>> {
  const tables: Partial<Record<PaperCorpusArchivePruneTableName, PaperCorpusStoragePaperTableFootprint>> = {};
  if (!paper) {
    return tables;
  }

  for (const tableName of PAPER_CORPUS_ARCHIVE_PRUNE_TABLES) {
    const table = paper.tables[tableName];
    if (table && table.rowCount > 0) {
      tables[tableName] = table;
    }
  }

  return tables;
}

function sumRichEvidenceTables(
  tables: Partial<Record<PaperCorpusArchivePruneTableName, PaperCorpusStoragePaperTableFootprint>>,
) {
  return Object.values(tables).reduce(
    (total, table) => ({
      rowCount: total.rowCount + (table?.rowCount ?? 0),
      estimatedBytes: total.estimatedBytes + (table?.estimatedBytes ?? 0),
    }),
    { rowCount: 0, estimatedBytes: 0 },
  );
}

function archiveRichEvidenceTotals(storage: PaperCorpusStorageFootprint | null | undefined) {
  return (storage?.tiers ?? [])
    .filter((tier) =>
      tier.tier === "archive" &&
      PAPER_CORPUS_ARCHIVE_PRUNE_TABLES.includes(tier.tableName as PaperCorpusArchivePruneTableName)
    )
    .reduce(
      (total, tier) => ({
        rowCount: total.rowCount + tier.rowCount,
        estimatedBytes: total.estimatedBytes + tier.estimatedBytes,
      }),
      { rowCount: 0, estimatedBytes: 0 },
    );
}

function normalizeDateIso(value: string | Date | null | undefined, fallback: Date): string {
  const parsed = toDate(value ?? fallback);
  return parsed?.toISOString() ?? fallback.toISOString();
}

export function buildPaperCorpusArchivePrunePlan(
  rows: PaperCorpusRefreshRow[],
  options: PaperCorpusArchivePrunePlanOptions = {},
): PaperCorpusArchivePrunePlan {
  const generatedAt = normalizeDateIso(options.generatedAt, new Date());
  const prunedAt = normalizeDateIso(options.prunedAt, new Date(generatedAt));
  const storageByFeedItemId = options.storageByFeedItemId ?? null;
  const protectedArchivePapers: PaperCorpusArchivePruneProtectedPaper[] = [];
  const tableTotals = new Map<PaperCorpusArchivePruneTableName, PaperCorpusArchivePruneTableSummary>(
    PAPER_CORPUS_ARCHIVE_PRUNE_TABLES.map((tableName) => [
      tableName,
      { tableName, rowCount: 0, estimatedBytes: 0 },
    ]),
  );
  const candidates: PaperCorpusArchivePruneCandidate[] = [];

  for (const row of rows) {
    const protectionReason = getPaperCorpusArchivePruneProtectionReason(row);
    if (row.corpus_tier === "archive" && protectionReason) {
      protectedArchivePapers.push({
        id: row.id,
        title: row.title,
        currentTier: row.corpus_tier,
        reason: protectionReason,
      });
    }
    if (protectionReason) {
      continue;
    }

    const paperStorage = storageFromLookup(storageByFeedItemId ?? undefined, row.id);
    const tables = richEvidenceTableFootprints(paperStorage);
    const totals = sumRichEvidenceTables(tables);
    if (totals.rowCount <= 0) {
      continue;
    }

    for (const [tableName, table] of Object.entries(tables) as Array<
      [PaperCorpusArchivePruneTableName, PaperCorpusStoragePaperTableFootprint]
    >) {
      const summary = tableTotals.get(tableName)!;
      summary.rowCount += table.rowCount;
      summary.estimatedBytes += table.estimatedBytes;
    }

    candidates.push({
      id: row.id,
      title: row.title,
      currentTier: row.corpus_tier,
      rowCount: totals.rowCount,
      estimatedBytes: totals.estimatedBytes,
      tables,
    });
  }

  const archiveTotals = archiveRichEvidenceTotals(options.storage);
  const rowCount = candidates.reduce((total, candidate) => total + candidate.rowCount, 0);
  const estimatedReclaimableBytes = candidates.reduce(
    (total, candidate) => total + candidate.estimatedBytes,
    0,
  );

  return {
    mode: options.mode ?? "dry-run",
    generatedAt,
    prunedAt,
    candidateCount: candidates.length,
    candidateIds: candidates.map((candidate) => candidate.id).sort((left, right) => left - right),
    rowCount,
    estimatedReclaimableBytes,
    archiveRichEvidenceRowCount: archiveTotals.rowCount,
    archiveRichEvidenceEstimatedBytes: archiveTotals.estimatedBytes,
    estimatedRemainingArchiveRichEvidenceBytes: Math.max(
      0,
      archiveTotals.estimatedBytes - estimatedReclaimableBytes,
    ),
    tables: [...tableTotals.values()],
    candidates: candidates.sort(
      (left, right) => right.estimatedBytes - left.estimatedBytes || left.id - right.id,
    ),
    protectedArchivePapers: protectedArchivePapers.sort((left, right) => left.id - right.id),
  };
}

export function buildRichEvidencePrunedTierMetadata(
  currentMetadata: PaperCorpusTierMetadata | null | undefined,
  prunedAt: string | Date,
): PaperCorpusTierMetadata {
  const prunedAtIso = normalizeDateIso(prunedAt, new Date());
  const currentRetention = currentMetadata?.retention ?? {};
  return {
    ...(currentMetadata ?? {}),
    retention: {
      ...currentRetention,
      richEvidencePrunedAt: prunedAtIso,
    },
  };
}

function formatTierCounts(counts: Record<CorpusTier, number>): string {
  return ["hot_set", "core_canon", "archive", "ignored"]
    .map((tier) => `${tier}=${counts[tier as CorpusTier]}`)
    .join(" | ");
}

function getAction(currentTier: CorpusTier, recommendedTier: CorpusTier): PaperCorpusRefreshActionType {
  if (TIER_RANK[recommendedTier] > TIER_RANK[currentTier]) {
    return "promote";
  }
  if (TIER_RANK[recommendedTier] < TIER_RANK[currentTier]) {
    return "demote";
  }
  return "keep";
}

function incrementTierCount(counts: Record<CorpusTier, number>, tier: CorpusTier) {
  counts[tier] += 1;
}

function normalizeOptions(
  optionsOrReferenceDate?: string | Date | PaperCorpusRefreshReportOptions,
): NormalizedPaperCorpusRefreshReportOptions {
  if (typeof optionsOrReferenceDate === "string" || optionsOrReferenceDate instanceof Date) {
    return {
      referenceDate: optionsOrReferenceDate,
      archiveLookbackDays: DEFAULT_ARCHIVE_LOOKBACK_DAYS,
      storage: null,
      previousPopularityByFeedItemId: null,
    };
  }

  return {
    referenceDate: optionsOrReferenceDate?.referenceDate ?? new Date(),
    archiveLookbackDays: optionsOrReferenceDate?.archiveLookbackDays ?? DEFAULT_ARCHIVE_LOOKBACK_DAYS,
    storage: optionsOrReferenceDate?.storage ?? null,
    previousPopularityByFeedItemId: optionsOrReferenceDate?.previousPopularityByFeedItemId ?? null,
  };
}

function scoreFreshness(referenceDate: Date, publishedAt: string | Date | null | undefined) {
  const age = ageDays(referenceDate, publishedAt);
  if (age == null) {
    return {
      points: 0,
      reason: "freshness unavailable",
    };
  }
  if (age <= 14) {
    return {
      points: 40,
      reason: `strong freshness window: ${age} days old`,
    };
  }
  if (age <= 30) {
    return {
      points: 25,
      reason: `moderate freshness window: ${age} days old`,
    };
  }
  if (age <= 60) {
    return {
      points: 10,
      reason: `weak freshness window: ${age} days old`,
    };
  }
  return {
    points: 0,
    reason: `freshness expired: ${age} days old`,
  };
}

function scorePopularity(popularity: PaperCorpusPopularitySnapshot): { points: number; reasons: string[] } {
  const reasons: string[] = [];
  let points = 0;

  if (popularity.hfUpvotes >= 50) {
    points += 18;
    reasons.push(`${popularity.hfUpvotes} HF upvotes`);
  } else if (popularity.hfUpvotes >= 20) {
    points += 12;
    reasons.push(`${popularity.hfUpvotes} HF upvotes`);
  } else if (popularity.hfUpvotes >= 5) {
    points += 6;
    reasons.push(`${popularity.hfUpvotes} HF upvotes`);
  } else if (popularity.hfUpvotes > 0) {
    points += 2;
    reasons.push(`${popularity.hfUpvotes} HF upvotes`);
  }

  if (popularity.hfComments >= 10) {
    points += 8;
    reasons.push(`${popularity.hfComments} HF comments`);
  } else if (popularity.hfComments >= 3) {
    points += 5;
    reasons.push(`${popularity.hfComments} HF comments`);
  } else if (popularity.hfComments > 0) {
    points += 2;
    reasons.push(`${popularity.hfComments} HF comments`);
  }

  if (popularity.githubStars >= 500) {
    points += 24;
    reasons.push(`${popularity.githubStars} GitHub stars`);
  } else if (popularity.githubStars >= 100) {
    points += 16;
    reasons.push(`${popularity.githubStars} GitHub stars`);
  } else if (popularity.githubStars >= 25) {
    points += 8;
    reasons.push(`${popularity.githubStars} GitHub stars`);
  } else if (popularity.githubStars > 0) {
    points += 3;
    reasons.push(`${popularity.githubStars} GitHub stars`);
  }

  if (popularity.githubRepo) {
    points += 3;
    reasons.push(`GitHub repository: ${popularity.githubRepo}`);
  }

  return { points, reasons };
}

function scoreGrowth(growth: PaperCorpusPopularityGrowth): { points: number; reasons: string[] } {
  const reasons: string[] = [];
  if (!growth.hasPriorSnapshot) {
    return {
      points: 0,
      reasons: ["no previous popularity snapshot; growth scored as 0"],
    };
  }

  let points = 0;
  if (growth.hfUpvotes >= 20) {
    points += 16;
    reasons.push(`HF upvotes grew by ${growth.hfUpvotes}`);
  } else if (growth.hfUpvotes >= 5) {
    points += 8;
    reasons.push(`HF upvotes grew by ${growth.hfUpvotes}`);
  } else if (growth.hfUpvotes > 0) {
    points += 3;
    reasons.push(`HF upvotes grew by ${growth.hfUpvotes}`);
  }

  if (growth.hfComments >= 5) {
    points += 6;
    reasons.push(`HF comments grew by ${growth.hfComments}`);
  } else if (growth.hfComments > 0) {
    points += 2;
    reasons.push(`HF comments grew by ${growth.hfComments}`);
  }

  if (growth.githubStars >= 100) {
    points += 16;
    reasons.push(`GitHub stars grew by ${growth.githubStars}`);
  } else if (growth.githubStars >= 20) {
    points += 8;
    reasons.push(`GitHub stars grew by ${growth.githubStars}`);
  } else if (growth.githubStars > 0) {
    points += 3;
    reasons.push(`GitHub stars grew by ${growth.githubStars}`);
  }

  if (reasons.length === 0) {
    reasons.push("previous popularity snapshot found; no positive growth");
  }
  return { points, reasons };
}

function extractCurrentPopularity(paperMeta: PaperMeta | null | undefined): PaperCorpusPopularitySnapshot {
  const hfProvider = paperMeta?.providers?.hf;
  const alphaxivProvider = paperMeta?.providers?.alphaxiv;
  const githubRepo = paperMeta?.githubRepo ?? hfProvider?.githubRepo ?? alphaxivProvider?.githubUrl ?? null;
  return {
    hfUpvotes: maxNumber(paperMeta?.upvotes, hfProvider?.upvotes, alphaxivProvider?.votes),
    hfComments: maxNumber(paperMeta?.numComments, hfProvider?.numComments),
    githubStars: maxNumber(paperMeta?.githubStars, hfProvider?.githubStars, alphaxivProvider?.githubStars),
    githubRepo,
    reviewedAt: null,
  };
}

function snapshotFromRecord(value: unknown): PaperCorpusPopularitySnapshot | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  return {
    hfUpvotes: maxNumber(record.hfUpvotes, record.hf_upvotes, record.upvotes),
    hfComments: maxNumber(record.hfComments, record.hf_comments, record.numComments, record.comments),
    githubStars: maxNumber(record.githubStars, record.github_stars, record.stars),
    githubRepo: asString(record.githubRepo) ?? asString(record.github_repo) ?? asString(record.repositoryUrl),
    reviewedAt: asString(record.reviewedAt) ?? asString(record.reviewed_at),
  };
}

function extractPreviousPopularity(
  metadata: PaperCorpusTierMetadata | null | undefined,
): PaperCorpusPopularitySnapshot | null {
  const record = asRecord(metadata);
  if (!record) {
    return null;
  }
  const direct = snapshotFromRecord(record.popularity);
  if (direct) {
    return direct;
  }
  const previous = snapshotFromRecord(record.previousPopularity);
  if (previous) {
    return previous;
  }
  const signals = asRecord(record.signals);
  return (
    snapshotFromRecord(signals?.popularity) ??
    snapshotFromRecord(signals?.previousPopularity) ??
    snapshotFromRecord(signals?.lastPopularity)
  );
}

function previousPopularityFromLookup(
  lookup: Map<number, PaperCorpusPopularitySnapshot> | Record<number, PaperCorpusPopularitySnapshot> | null,
  feedItemId: number,
): PaperCorpusPopularitySnapshot | null {
  if (!lookup) {
    return null;
  }
  if (lookup instanceof Map) {
    return lookup.get(feedItemId) ?? null;
  }
  return lookup[feedItemId] ?? null;
}

function calculateGrowth(
  current: PaperCorpusPopularitySnapshot,
  previous: PaperCorpusPopularitySnapshot | null,
): PaperCorpusPopularityGrowth {
  if (!previous) {
    return {
      hfUpvotes: 0,
      hfComments: 0,
      githubStars: 0,
      hasPriorSnapshot: false,
    };
  }
  return {
    hfUpvotes: Math.max(0, current.hfUpvotes - previous.hfUpvotes),
    hfComments: Math.max(0, current.hfComments - previous.hfComments),
    githubStars: Math.max(0, current.githubStars - previous.githubStars),
    hasPriorSnapshot: true,
  };
}

function getManualOverride(row: PaperCorpusRefreshRow): PaperCorpusManualOverride | null {
  const metadata = row.tier_metadata_json;
  if (metadata?.ignored) {
    return {
      type: "ignored",
      recommendedTier: "ignored",
      detail: "tier_metadata_json.ignored=true",
    };
  }
  if (row.corpus_tier === "ignored") {
    return {
      type: "currentIgnoredTier",
      recommendedTier: "ignored",
      detail: "current corpus_tier=ignored",
    };
  }
  if (metadata?.manualTier) {
    return {
      type: "manualTier",
      recommendedTier: metadata.manualTier,
      detail: `tier_metadata_json.manualTier=${metadata.manualTier}`,
    };
  }
  if (metadata?.pinned) {
    return {
      type: "pinned",
      recommendedTier: "hot_set",
      detail: "tier_metadata_json.pinned=true",
    };
  }
  return null;
}

function numberFromMetadata(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isWithinIntakeHotSetGrace(
  row: PaperCorpusRefreshRow,
  referenceDate: Date,
): boolean {
  const retention = row.tier_metadata_json?.retention;
  if (retention?.intakeDefaultTier !== "hot_set") {
    return false;
  }

  const selectedAtRaw = typeof retention.selectedAt === "string" ? retention.selectedAt : null;
  const pendingStartedAtRaw =
    typeof retention.pendingReviewStartedAt === "string"
      ? retention.pendingReviewStartedAt
      : null;
  const selectedAt = toDate(selectedAtRaw) ?? toDate(pendingStartedAtRaw);
  if (!selectedAt) {
    return false;
  }

  const graceDays = numberFromMetadata(retention.graceDays) ?? 14;
  const pendingAgeDays = (referenceDate.getTime() - selectedAt.getTime()) / DAY_MS;
  return pendingAgeDays >= 0 && pendingAgeDays <= graceDays;
}

function reviewGroupForRow(
  row: PaperCorpusRefreshRow,
  referenceDate: Date,
  archiveLookbackDays: number,
): PaperCorpusReviewGroup | null {
  if (row.corpus_tier === "hot_set") {
    return "hot_set";
  }
  if (row.corpus_tier === "core_canon") {
    return "core_canon";
  }
  if (row.corpus_tier === "ignored") {
    return "ignored";
  }
  const manualOverride = getManualOverride(row);
  if (manualOverride) {
    return row.corpus_tier === "archive" ? "recent_archive" : "ignored";
  }
  const age = ageDays(referenceDate, row.published_at);
  if (row.corpus_tier === "archive" && age != null && age <= archiveLookbackDays) {
    return "recent_archive";
  }
  return null;
}

function recommendAutomaticTier(
  row: PaperCorpusRefreshRow,
  score: number,
  scoreComponents: PaperCorpusReviewScoreComponents,
): CorpusTier {
  const popularityAndGrowth = scoreComponents.popularity + scoreComponents.growth;

  if (row.corpus_tier === "hot_set") {
    if (score >= HOT_SET_KEEP_SCORE) {
      return "hot_set";
    }
    if (score >= HOT_SET_TO_CORE_SCORE || popularityAndGrowth >= ARCHIVE_TO_CORE_POPULARITY_SCORE) {
      return "core_canon";
    }
    return "archive";
  }

  if (row.corpus_tier === "core_canon") {
    if (
      score >= HOT_PROMOTION_SCORE ||
      scoreComponents.popularity >= HOT_PROMOTION_POPULARITY_SCORE ||
      scoreComponents.growth >= HOT_PROMOTION_GROWTH_SCORE
    ) {
      return "hot_set";
    }
    if (score >= CORE_CANON_KEEP_SCORE || popularityAndGrowth >= ARCHIVE_TO_CORE_POPULARITY_SCORE) {
      return "core_canon";
    }
    return "archive";
  }

  if (row.corpus_tier === "ignored") {
    return "ignored";
  }

  if (
    score >= HOT_PROMOTION_SCORE ||
    scoreComponents.popularity >= HOT_PROMOTION_POPULARITY_SCORE ||
    scoreComponents.growth >= HOT_PROMOTION_GROWTH_SCORE
  ) {
    return "hot_set";
  }
  if (popularityAndGrowth >= ARCHIVE_TO_CORE_POPULARITY_SCORE) {
    return "core_canon";
  }
  return "archive";
}

function buildScoredReview(
  row: PaperCorpusRefreshRow,
  referenceDate: Date,
  archiveLookbackDays: number,
  previousPopularityByFeedItemId: Map<number, PaperCorpusPopularitySnapshot> | Record<number, PaperCorpusPopularitySnapshot> | null,
): ScoredReview | null {
  const reviewGroup = reviewGroupForRow(row, referenceDate, archiveLookbackDays);
  if (!reviewGroup) {
    return null;
  }

  const freshness = scoreFreshness(referenceDate, row.published_at);
  const popularity = extractCurrentPopularity(row.paper_meta);
  const previousPopularity =
    previousPopularityFromLookup(previousPopularityByFeedItemId, row.id) ??
    extractPreviousPopularity(row.tier_metadata_json);
  const popularityGrowth = calculateGrowth(popularity, previousPopularity);
  const popularityScore = scorePopularity(popularity);
  const growthScore = scoreGrowth(popularityGrowth);
  const scoreComponents = {
    freshness: freshness.points,
    popularity: popularityScore.points,
    growth: growthScore.points,
  };
  const score = scoreComponents.freshness + scoreComponents.popularity + scoreComponents.growth;
  const manualOverride = getManualOverride(row);
  const preserveIntakeHotSet =
    !manualOverride && isWithinIntakeHotSetGrace(row, referenceDate);
  const recommendedTier =
    manualOverride?.recommendedTier ??
    (preserveIntakeHotSet
      ? "hot_set"
      : recommendAutomaticTier(row, score, scoreComponents));

  const reasons = [
    "topic match assumed eligible from paper intake; not scored",
    freshness.reason,
    ...popularityScore.reasons,
    ...growthScore.reasons,
  ];
  if (preserveIntakeHotSet) {
    reasons.push(INTAKE_HOT_SET_GRACE_REASON);
  }
  if (manualOverride) {
    reasons.push(`manual override preserved: ${manualOverride.detail}`);
  }
  if (reasons.length === 2 && reasons[1] === "freshness unavailable") {
    reasons.push("no external popularity signals found");
  }

  return {
    row,
    reviewGroup,
    recommendedTier,
    score,
    scoreComponents,
    popularity,
    previousPopularity,
    popularityGrowth,
    manualOverride,
    reasons,
  };
}

function summarizeReview(scored: ScoredReview): string {
  const override = scored.manualOverride
    ? `; ${scored.manualOverride.type} override preserved`
    : "";
  return `${scored.recommendedTier} (${scored.score}; freshness=${scored.scoreComponents.freshness}, popularity=${scored.scoreComponents.popularity}, growth=${scored.scoreComponents.growth})${override}`;
}

function currentSummary(scored: ScoredReview): string {
  return `${scored.row.corpus_tier} before review`;
}

function recommendationFromScoredReview(scored: ScoredReview, referenceDate: Date): PaperCorpusRefreshRecommendation {
  const row = scored.row;
  return {
    id: row.id,
    currentTier: row.corpus_tier,
    recommendedTier: scored.recommendedTier,
    action: getAction(row.corpus_tier, scored.recommendedTier),
    reviewGroup: scored.reviewGroup,
    score: scored.score,
    scoreComponents: scored.scoreComponents,
    popularity: scored.popularity,
    previousPopularity: scored.previousPopularity,
    popularityGrowth: scored.popularityGrowth,
    manualOverride: scored.manualOverride,
    summary: summarizeReview(scored),
    currentSummary: currentSummary(scored),
    reasons: scored.reasons,
    ageDays: ageDays(referenceDate, row.published_at),
    title: row.title,
    publishedAt: toDate(row.published_at)?.toISOString() ?? null,
  };
}

function sortRecommendations(
  recommendations: PaperCorpusRefreshRecommendation[],
): PaperCorpusRefreshRecommendation[] {
  return [...recommendations].sort((left, right) => {
    if (left.action !== right.action) {
      return left.action.localeCompare(right.action);
    }
    if (left.action === "demote") {
      return left.score - right.score || left.id - right.id;
    }
    return right.score - left.score || left.id - right.id;
  });
}

export function buildPaperCorpusRefreshReport(
  rows: PaperCorpusRefreshRow[],
  optionsOrReferenceDate?: string | Date | PaperCorpusRefreshReportOptions,
): PaperCorpusRefreshReport {
  const options = normalizeOptions(optionsOrReferenceDate);
  const ref = options.referenceDate instanceof Date ? options.referenceDate : new Date(options.referenceDate);
  const archiveLookbackDays = options.archiveLookbackDays;
  const currentTierCounts: Record<CorpusTier, number> = {
    hot_set: 0,
    core_canon: 0,
    archive: 0,
    ignored: 0,
  };
  const recommendedTierCounts: Record<CorpusTier, number> = {
    hot_set: 0,
    core_canon: 0,
    archive: 0,
    ignored: 0,
  };

  let skippedArchiveCount = 0;
  const recommendations = rows.flatMap((row) => {
    const scored = buildScoredReview(row, ref, archiveLookbackDays, options.previousPopularityByFeedItemId);
    if (!scored) {
      if (row.corpus_tier === "archive") {
        skippedArchiveCount += 1;
      }
      return [];
    }
    incrementTierCount(currentTierCounts, row.corpus_tier);
    incrementTierCount(recommendedTierCounts, scored.recommendedTier);
    return [recommendationFromScoredReview(scored, ref)];
  });

  const sortedRecommendations = sortRecommendations(recommendations);
  const promotions = sortedRecommendations.filter((item) => item.action === "promote");
  const demotions = sortedRecommendations.filter((item) => item.action === "demote");
  const keeps = sortedRecommendations.filter((item) => item.action === "keep");
  const manualOverrides = sortedRecommendations.filter((item) => item.manualOverride);

  return {
    referenceDate: ref.toISOString(),
    generatedAt: new Date().toISOString(),
    archiveLookbackDays,
    totalInputCount: rows.length,
    totalCount: recommendations.length,
    reviewedCount: recommendations.length,
    skippedArchiveCount,
    keepCount: keeps.length,
    promoteCount: promotions.length,
    demoteCount: demotions.length,
    manualOverrideCount: manualOverrides.length,
    currentTierCounts,
    recommendedTierCounts,
    hotSetRecommendations: sortedRecommendations.filter((item) => item.reviewGroup === "hot_set"),
    coreCanonRecommendations: sortedRecommendations.filter((item) => item.reviewGroup === "core_canon"),
    recentArchiveRecommendations: sortedRecommendations.filter((item) => item.reviewGroup === "recent_archive"),
    ignoredRecommendations: sortedRecommendations.filter((item) => item.reviewGroup === "ignored"),
    manualOverrides,
    promotions,
    demotions,
    keeps,
    storage: options.storage,
  };
}

function allRecommendations(report: PaperCorpusRefreshReport): PaperCorpusRefreshRecommendation[] {
  return [
    ...report.hotSetRecommendations,
    ...report.coreCanonRecommendations,
    ...report.recentArchiveRecommendations,
    ...report.ignoredRecommendations,
  ];
}

function storageFromLookup(
  storageByFeedItemId: Map<number, PaperCorpusStoragePaperFootprint> | Record<number, PaperCorpusStoragePaperFootprint> | undefined,
  feedItemId: number,
): PaperCorpusStoragePaperFootprint | null {
  if (!storageByFeedItemId) {
    return null;
  }
  if (storageByFeedItemId instanceof Map) {
    return storageByFeedItemId.get(feedItemId) ?? null;
  }
  return storageByFeedItemId[feedItemId] ?? null;
}

function isPendingHotSetPromotion(item: Pick<PaperCorpusRefreshRecommendation, "currentTier" | "recommendedTier">) {
  return item.currentTier !== "hot_set" && item.recommendedTier === "hot_set";
}

function isGracePreservedIntakeHotSetPromotion(
  item: Pick<PaperCorpusRefreshRecommendation, "reasons">,
  currentRetention: NonNullable<PaperCorpusTierMetadata["retention"]>,
) {
  return (
    currentRetention.intakeDefaultTier === "hot_set" &&
    currentRetention.pendingTier === "hot_set" &&
    currentRetention.pendingReviewAction === "intake_to_hot_set" &&
    item.reasons.includes(INTAKE_HOT_SET_GRACE_REASON)
  );
}

export function buildPaperCorpusReviewRunSummary(
  report: PaperCorpusRefreshReport,
): PaperCorpusReviewRunSummary {
  return {
    referenceDate: report.referenceDate,
    generatedAt: report.generatedAt,
    totalInputCount: report.totalInputCount,
    reviewedCount: report.reviewedCount,
    skippedArchiveCount: report.skippedArchiveCount,
    keepCount: report.keepCount,
    promoteCount: report.promoteCount,
    demoteCount: report.demoteCount,
    manualOverrideCount: report.manualOverrideCount,
    currentTierCounts: report.currentTierCounts,
    recommendedTierCounts: report.recommendedTierCounts,
  };
}

export function buildPaperCorpusReviewItemSnapshots(
  report: PaperCorpusRefreshReport,
  options: {
    mode: PaperCorpusReviewRunMode;
    storageByFeedItemId?: Map<number, PaperCorpusStoragePaperFootprint> | Record<number, PaperCorpusStoragePaperFootprint>;
  },
): PaperCorpusReviewItemSnapshot[] {
  return allRecommendations(report).map((item) => ({
    feedItemId: item.id,
    previousTier: item.currentTier,
    recommendedTier: item.recommendedTier,
    appliedTier:
      options.mode === "execute_tier_updates" && !isPendingHotSetPromotion(item)
        ? item.recommendedTier
        : item.currentTier,
    action: item.action,
    ageDays: item.ageDays,
    score: item.score,
    freshnessScore: item.scoreComponents.freshness,
    popularityScore: item.scoreComponents.popularity,
    popularityGrowthScore: item.scoreComponents.growth,
    hfUpvotes: item.popularity.hfUpvotes,
    hfComments: item.popularity.hfComments,
    githubStars: item.popularity.githubStars,
    githubRepo: item.popularity.githubRepo,
    previousHfUpvotes: item.previousPopularity?.hfUpvotes ?? null,
    previousHfComments: item.previousPopularity?.hfComments ?? null,
    previousGithubStars: item.previousPopularity?.githubStars ?? null,
    reasons: item.reasons,
    manualOverride: Boolean(item.manualOverride),
    manualOverrideType: item.manualOverride?.type ?? null,
    manualOverrideDetail: item.manualOverride?.detail ?? null,
    popularity: item.popularity,
    popularityGrowth: item.popularityGrowth,
    storage: storageFromLookup(options.storageByFeedItemId, item.id),
  }));
}

export function buildPaperCorpusReviewPersistenceSnapshot(
  report: PaperCorpusRefreshReport,
  options: {
    mode: PaperCorpusReviewRunMode;
    hotSetTarget?: number;
    hotSetCap?: number;
    coreCanonTarget?: number;
    storageByFeedItemId?: Map<number, PaperCorpusStoragePaperFootprint> | Record<number, PaperCorpusStoragePaperFootprint>;
  },
): PaperCorpusReviewPersistenceSnapshot {
  return {
    mode: options.mode,
    hotSetTarget: options.hotSetTarget ?? DEFAULT_HOT_SET_TARGET,
    hotSetCap: options.hotSetCap ?? DEFAULT_HOT_SET_CAP,
    coreCanonTarget: options.coreCanonTarget ?? DEFAULT_CORE_CANON_TARGET,
    archiveLookbackDays: report.archiveLookbackDays,
    summary: buildPaperCorpusReviewRunSummary(report),
    items: buildPaperCorpusReviewItemSnapshots(report, {
      mode: options.mode,
      storageByFeedItemId: options.storageByFeedItemId,
    }),
  };
}

function reasonText(reasons: string[]): string | null {
  return reasons.length > 0 ? reasons.join("; ") : null;
}

export function buildPaperCorpusTierReviewUpdatePayload(
  item: PaperCorpusRefreshRecommendation,
  options: {
    currentMetadata?: PaperCorpusTierMetadata | null;
    reviewRunId: number;
    reviewedAt?: string | Date;
  },
): PaperCorpusTierReviewUpdatePayload {
  const reviewedAt = toDate(options.reviewedAt ?? new Date())?.toISOString() ?? new Date().toISOString();
  const primaryReason = reasonText(item.reasons);
  const pendingHotSetPromotion = isPendingHotSetPromotion(item);
  const appliedTier = pendingHotSetPromotion ? item.currentTier : item.recommendedTier;
  const action = pendingHotSetPromotion
    ? `${item.currentTier}_to_pending_hot_set`
    : `${item.currentTier}_to_${item.recommendedTier}`;
  const currentRetention = options.currentMetadata?.retention ?? {};
  const gracePreservedIntakePromotion =
    pendingHotSetPromotion && isGracePreservedIntakeHotSetPromotion(item, currentRetention);
  const pendingReviewAction = gracePreservedIntakePromotion
    ? "intake_to_hot_set"
    : `${item.currentTier}_to_${item.recommendedTier}`;
  const pendingReviewStartedAt = gracePreservedIntakePromotion
    ? currentRetention.pendingReviewStartedAt ?? currentRetention.selectedAt ?? reviewedAt
    : reviewedAt;
  const tierMetadata: PaperCorpusTierMetadata = {
    ...(options.currentMetadata ?? {}),
    lastReviewRunId: options.reviewRunId,
    lastReviewAction: action,
    lastReviewReasons: item.reasons,
    popularity: {
      ...item.popularity,
      reviewedAt,
    },
    retention: pendingHotSetPromotion
      ? {
          ...currentRetention,
          pendingTier: "hot_set",
          pendingSourceTier: item.currentTier,
          pendingReviewRunId: options.reviewRunId,
          pendingReviewAction,
          pendingReviewStartedAt,
          pendingReviewReasons: item.reasons,
        }
      : {
          ...currentRetention,
          pendingTier: null,
          pendingSourceTier: null,
          pendingReviewRunId: null,
          pendingReviewAction: null,
          pendingReviewStartedAt: null,
          pendingReviewReasons: [],
        },
  };

  return {
    corpus_tier: appliedTier,
    recommended_tier: item.recommendedTier,
    pending_hot_set_promotion: pendingHotSetPromotion,
    relevance_score: item.score,
    canon_score: item.recommendedTier === "core_canon" ? item.score : null,
    hot_set_reason: item.recommendedTier === "hot_set" ? primaryReason : null,
    canon_reason: item.recommendedTier === "core_canon" ? primaryReason : null,
    archive_reason: item.recommendedTier === "archive" ? primaryReason : null,
    ignored_reason: item.recommendedTier === "ignored" ? primaryReason : null,
    last_scored_at: reviewedAt,
    tier_metadata_json: tierMetadata,
  };
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatRecommendationLine(item: PaperCorpusRefreshRecommendation): string {
  const age = item.ageDays == null ? "age=unknown" : `age=${item.ageDays}d`;
  const published = item.publishedAt ? `published=${item.publishedAt.slice(0, 10)}` : "published=unknown";
  const popularity =
    `hf=${item.popularity.hfUpvotes}/${item.popularity.hfComments}` +
    ` stars=${item.popularity.githubStars}`;
  const growth = item.popularityGrowth.hasPriorSnapshot
    ? `growth=+${item.popularityGrowth.hfUpvotes}/+${item.popularityGrowth.hfComments}/+${item.popularityGrowth.githubStars}`
    : "growth=0(no prior snapshot)";
  return `${item.id} ${item.currentTier} -> ${item.recommendedTier} (${item.score}) ${age} ${published} ${popularity} ${growth} :: ${item.title ?? "<untitled>"} :: ${item.summary}`;
}

function pushRecommendationSection(
  lines: string[],
  title: string,
  items: PaperCorpusRefreshRecommendation[],
  limit: number,
) {
  lines.push(`\n${title} (${items.length}):`);
  if (items.length === 0) {
    lines.push("  none");
    return;
  }
  for (const item of items.slice(0, limit)) {
    lines.push(`  ${formatRecommendationLine(item)}`);
  }
  if (items.length > limit) {
    lines.push(`  ... ${items.length - limit} more`);
  }
}

function pushStorageSection(lines: string[], storage: PaperCorpusStorageFootprint | null, limit: number) {
  lines.push("\nStorage footprint:");
  if (!storage) {
    lines.push("  not loaded");
    return;
  }
  if (storage.tables.length === 0 && storage.tiers.length === 0 && storage.largestPapers.length === 0) {
    lines.push("  no storage rows returned");
    return;
  }

  if (storage.tables.length > 0) {
    lines.push("  By table:");
    for (const table of storage.tables) {
      lines.push(
        `    ${table.tableName}: total=${formatBytes(table.totalBytes)} table=${formatBytes(table.tableBytes)} indexes=${formatBytes(table.indexBytes)}`,
      );
    }
  }

  if (storage.tiers.length > 0) {
    lines.push("  By table and tier:");
    for (const tier of storage.tiers.slice(0, limit * 4)) {
      lines.push(
        `    ${tier.tableName} ${tier.tier}: rows=${tier.rowCount} approx=${formatBytes(tier.estimatedBytes)}`,
      );
    }
  }

  if (storage.largestPapers.length > 0) {
    lines.push("  Largest papers:");
    for (const paper of storage.largestPapers.slice(0, limit)) {
      lines.push(
        `    ${paper.id} ${paper.currentTier} rows=${paper.rowCount} approx=${formatBytes(paper.estimatedBytes)} :: ${paper.title ?? "<untitled>"}`,
      );
    }
  }
}

function formatArchivePruneCandidateLine(candidate: PaperCorpusArchivePruneCandidate): string {
  const tables = PAPER_CORPUS_ARCHIVE_PRUNE_TABLES
    .map((tableName) => {
      const table = candidate.tables[tableName];
      return table ? `${tableName}=${table.rowCount}` : null;
    })
    .filter(Boolean)
    .join(" ");
  return `${candidate.id} rows=${candidate.rowCount} approx=${formatBytes(candidate.estimatedBytes)} ${tables} :: ${candidate.title ?? "<untitled>"}`;
}

export function formatPaperCorpusArchivePrunePlan(
  plan: PaperCorpusArchivePrunePlan,
  options: PaperCorpusRefreshTextOptions = {},
): string {
  const limit = options.sectionLimit ?? 15;
  const modeLabel = options.modeLabel ?? plan.mode;
  const lines = [
    "",
    "Archive Rich Evidence Prune Report",
    `Mode: ${modeLabel}`,
    `Generated at: ${plan.generatedAt}`,
    `Pruned-at marker: ${plan.prunedAt}`,
    `Candidate papers: ${plan.candidateCount}`,
    `Candidate IDs: ${plan.candidateIds.length > 0 ? plan.candidateIds.join(", ") : "none"}`,
    `Candidate rich rows: ${plan.rowCount}`,
    `Estimated reclaimable storage: ${formatBytes(plan.estimatedReclaimableBytes)}`,
    `Archive rich evidence before prune: rows=${plan.archiveRichEvidenceRowCount} approx=${formatBytes(plan.archiveRichEvidenceEstimatedBytes)}`,
    `Estimated archive rich evidence after prune: ${formatBytes(plan.estimatedRemainingArchiveRichEvidenceBytes)}`,
    "Deletes are limited to paper_evidence_cards, paper_reader_profiles, paper_evidence_spans, and paper_sections. Feed items, digests, source references, knowledge_chunks, provider metadata, and processing state are preserved.",
  ];

  lines.push("  By table:");
  for (const table of plan.tables) {
    lines.push(`    ${table.tableName}: rows=${table.rowCount} approx=${formatBytes(table.estimatedBytes)}`);
  }

  lines.push(`  Candidates (${plan.candidates.length}):`);
  if (plan.candidates.length === 0) {
    lines.push("    none");
  } else {
    for (const candidate of plan.candidates.slice(0, limit)) {
      lines.push(`    ${formatArchivePruneCandidateLine(candidate)}`);
    }
    if (plan.candidates.length > limit) {
      lines.push(`    ... ${plan.candidates.length - limit} more`);
    }
  }

  lines.push(`  Protected archive papers (${plan.protectedArchivePapers.length}):`);
  if (plan.protectedArchivePapers.length === 0) {
    lines.push("    none");
  } else {
    for (const paper of plan.protectedArchivePapers.slice(0, limit)) {
      lines.push(`    ${paper.id} ${paper.reason} :: ${paper.title ?? "<untitled>"}`);
    }
    if (plan.protectedArchivePapers.length > limit) {
      lines.push(`    ... ${plan.protectedArchivePapers.length - limit} more`);
    }
  }

  return lines.join("\n");
}

export function formatPaperCorpusRefreshReport(
  report: PaperCorpusRefreshReport,
  options: PaperCorpusRefreshTextOptions = {},
): string {
  const limit = options.sectionLimit ?? 15;
  const lines = [
    "Paper Corpus Retention Review Report",
    `Mode: ${options.modeLabel ?? "dry-run/read-only"}`,
    `Reference date: ${report.referenceDate}`,
    `Generated at: ${report.generatedAt}`,
    `Archive lookback: ${report.archiveLookbackDays} days`,
    `Input papers: ${report.totalInputCount}`,
    `Reviewed papers: ${report.reviewedCount}`,
    `Skipped archive papers outside lookback: ${report.skippedArchiveCount}`,
    `Current reviewed tiers: ${formatTierCounts(report.currentTierCounts)}`,
    `Recommended tiers: ${formatTierCounts(report.recommendedTierCounts)}`,
    `Changes: promote=${report.promoteCount} demote=${report.demoteCount} keep=${report.keepCount}`,
    `Manual override protections: ${report.manualOverrideCount}`,
    "Scoring: freshness + current external popularity + popularity growth. Topic matching is treated as an eligibility assumption from paper intake.",
  ];

  pushRecommendationSection(lines, "Hot Set recommendations", report.hotSetRecommendations, limit);
  pushRecommendationSection(lines, "Core Canon recommendations", report.coreCanonRecommendations, limit);
  pushRecommendationSection(lines, "Recent Archive recommendations", report.recentArchiveRecommendations, limit);
  pushRecommendationSection(lines, "Ignored recommendations", report.ignoredRecommendations, limit);
  pushRecommendationSection(lines, "Manual override protections", report.manualOverrides, limit);
  pushRecommendationSection(lines, "Promotions", report.promotions, limit);
  pushRecommendationSection(lines, "Demotions", report.demotions, limit);
  pushRecommendationSection(lines, "Keeps", report.keeps, limit);
  pushStorageSection(lines, report.storage, limit);

  return lines.join("\n");
}
