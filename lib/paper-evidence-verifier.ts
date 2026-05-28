import {
  normalizeForLabelMatch as normalizeForMatch,
  normalizeWhitespace,
} from "@/lib/paper-evidence-normalization";
import type { MemorySearchChunkHit, PaperEvidenceMetadata } from "@/lib/schema";

export {
  normalizeForLabelMatch,
  normalizeWhitespace,
} from "@/lib/paper-evidence-normalization";

const CLAIM_STOPWORDS = new Set([
  "about",
  "after",
  "against",
  "also",
  "among",
  "before",
  "being",
  "between",
  "covered",
  "covers",
  "detail",
  "details",
  "did",
  "does",
  "from",
  "have",
  "how",
  "into",
  "only",
  "over",
  "paper",
  "papers",
  "report",
  "reports",
  "research",
  "say",
  "says",
  "show",
  "shows",
  "study",
  "studies",
  "that",
  "their",
  "these",
  "this",
  "through",
  "under",
  "use",
  "used",
  "using",
  "what",
  "when",
  "where",
  "which",
  "with",
  "why",
]);

const CORPUS_META_TERMS = new Set([
  "agent",
  "agents",
  "ai",
  "benchmark",
  "benchmarks",
  "model",
  "models",
]);

const DETAIL_TERMS = new Set([
  "ablation",
  "accuracy",
  "benchmark",
  "benchmarks",
  "dataset",
  "datasets",
  "dosage",
  "guideline",
  "guidelines",
  "metric",
  "metrics",
  "protocol",
  "result",
  "results",
  "score",
  "scores",
  "table",
]);

const GENERIC_ANCHOR_TERMS = new Set([
  "agent",
  "agents",
  "ai",
  "approach",
  "benchmark",
  "benchmarks",
  "dataset",
  "datasets",
  "evaluation",
  "framework",
  "method",
  "methods",
  "model",
  "models",
  "paper",
  "papers",
  "policy",
  "research",
  "result",
  "results",
  "study",
  "system",
  "systems",
  "task",
  "tasks",
  "verification",
]);

export type PaperEvidenceClaimTerm = {
  value: string;
  normalized: string;
  kind: "number" | "high_signal" | "term";
};

type PaperEvidenceAnchorKind =
  | "paper_identity_anchor"
  | "claim_anchor"
  | "numeric_or_detail_anchor";

const PAPER_EVIDENCE_TOKEN_PATTERN =
  /\d+(?:\.\d+)?[A-Za-z][A-Za-z0-9+#.]*(?:[-@][A-Za-z0-9+#.]+)*|[A-Za-z][A-Za-z0-9+#.]*(?:[-@][A-Za-z0-9+#.]+)*|\d+(?:\.\d+)?\s*(?:%|percent)?/g;

export type PaperEvidenceChunkCandidate = MemorySearchChunkHit & {
  text?: string | null;
  chunk_index?: number | null;
};

export type PaperEvidenceChunkVerification = {
  hit: PaperEvidenceChunkCandidate;
  supports: boolean;
  matchedTerms: string[];
  matchedNumbers: string[];
  matchedAnchorGroups: string[];
  missingAnchorGroups: string[];
  anchorGroupsByKind: Record<PaperEvidenceAnchorKind, string[]>;
  identityAnchorMatches: {
    candidate: string[];
    title: string[];
    metadata: string[];
    chunk: string[];
    snippet: string[];
  };
  claimDetailAnchorMatches: string[];
  coverage: number;
  isPaperCard: boolean;
  isReferenceLike: boolean;
  demotionReason: string | null;
  reason: string;
};

export type PaperEvidenceVerification = {
  metadata: PaperEvidenceMetadata;
  chunks: PaperEvidenceChunkVerification[];
};

function normalizeNumber(value: string): string {
  return value.toLowerCase().replace(/\s*percent\b/g, "%").replace(/\s+/g, "");
}

function uniqueByNormalized(terms: PaperEvidenceClaimTerm[]) {
  const seen = new Set<string>();
  const result: PaperEvidenceClaimTerm[] = [];
  for (const term of terms) {
    if (!term.normalized || seen.has(term.normalized)) {
      continue;
    }
    seen.add(term.normalized);
    result.push(term);
  }
  return result;
}

function extractTokens(value: string): string[] {
  return (value.match(PAPER_EVIDENCE_TOKEN_PATTERN) ?? []).map(
    normalizeWhitespace,
  );
}

function isNumberToken(token: string): boolean {
  return /^\d+(?:\.\d+)?\s*(?:%|percent)?$/i.test(token);
}

function isAcronymOrName(token: string): boolean {
  return (
    /^[A-Z0-9+#]{2,}(?:[-@][A-Za-z0-9+#]+)*$/.test(token) ||
    /^[A-Z][A-Za-z0-9+#]*(?:[-@][A-Za-z0-9+#]+)*$/.test(token)
  );
}

function isHighSignalToken(token: string): boolean {
  const normalized = normalizeForMatch(token);
  return (
    isAcronymOrName(token) ||
    /[-@]/.test(token) ||
    (normalized.length >= 7 &&
      !CLAIM_STOPWORDS.has(normalized) &&
      !CORPUS_META_TERMS.has(normalized))
  );
}

function termVariants(term: PaperEvidenceClaimTerm): string[] {
  const normalized = term.normalized;
  const variants = new Set([normalized]);
  variants.add(normalized.replace(/\b(\d+(?:\.\d+)?)\s+%\b/g, "$1%"));
  variants.add(normalized.replace(/\b(\d+(?:\.\d+)?)%\b/g, "$1 %"));
  return [...variants].filter(Boolean);
}

type ConcreteAnchorGroup = {
  label: string;
  variants: string[];
  kind: PaperEvidenceAnchorKind;
  allowLooseTokenMatch: boolean;
};

function anchorKey(value: string): string {
  return normalizeForMatch(value);
}

function isGenericAnchor(value: string): boolean {
  const normalized = anchorKey(value);
  if (!normalized) {
    return true;
  }
  const words = normalized.split(/\s+/).filter(Boolean);
  return words.length > 0 && words.every((word) => GENERIC_ANCHOR_TERMS.has(word));
}

function addAnchorGroup(
  groups: ConcreteAnchorGroup[],
  seen: Set<string>,
  label: string,
  variants = [label],
  kind: PaperEvidenceAnchorKind = "claim_anchor",
  options: { allowLooseTokenMatch?: boolean } = {},
) {
  if (isGenericAnchor(label)) {
    return;
  }
  const normalizedVariants = uniqueByNormalized(
    variants.map((variant) => ({
      value: variant,
      normalized: anchorKey(variant),
      kind: "high_signal" as const,
    })),
  )
    .map((variant) => variant.normalized)
    .filter((variant) => variant && !isGenericAnchor(variant));
  if (normalizedVariants.length === 0) {
    return;
  }
  const normalizedLabel = anchorKey(label);
  if (seen.has(normalizedLabel)) {
    return;
  }
  seen.add(normalizedLabel);
  groups.push({
    label: normalizedLabel,
    variants: normalizedVariants,
    kind,
    allowLooseTokenMatch: options.allowLooseTokenMatch ?? false,
  });
}

function addKubernetesPspAnchorGroups(
  query: string,
  groups: ConcreteAnchorGroup[],
  seen: Set<string>,
) {
  const normalized = normalizeForMatch(query);
  const hasKubernetes = /\bkubernetes\b/.test(normalized);
  const hasPsp = /\bpsp\b/.test(normalized) || /\bpod security polic(?:y|ies)\b/.test(normalized);
  if (!hasKubernetes || !hasPsp) {
    return;
  }

  addAnchorGroup(
    groups,
    seen,
    "kubernetes pod security",
    ["kubernetes", "pod security", "pod security admission"],
    "claim_anchor",
  );
  addAnchorGroup(
    groups,
    seen,
    "pod security policy",
    ["psp", "pod security policy", "pod security policies"],
    "claim_anchor",
  );

  if (/\bmigrat(?:e|ed|es|ing|ion)\b|\bdeprecat(?:e|ed|es|ing|ion)\b|\breplac(?:e|ed|es|ing|ement)\b/.test(normalized)) {
    addAnchorGroup(
      groups,
      seen,
      "migration",
      [
        "migration",
        "migrate",
        "migrating",
        "deprecated",
        "deprecation",
        "replacement",
        "replaced",
      ],
      "claim_anchor",
    );
  }
}

function concreteAnchorTokens(query: string): string[] {
  return (query.match(PAPER_EVIDENCE_TOKEN_PATTERN) ?? []).map(
    normalizeWhitespace,
  );
}

function isConcreteAnchorToken(token: string): boolean {
  const normalized = normalizeForMatch(token);
  if (CLAIM_STOPWORDS.has(normalized) || isGenericAnchor(normalized)) {
    return false;
  }
  return (
    isNumberToken(token) ||
    /^[A-Z0-9+#]{2,}(?:[-@][A-Za-z0-9+#.]+)*$/.test(token) ||
    /^[A-Z][A-Za-z0-9+#.]*(?:[-@][A-Za-z0-9+#.]+)*$/.test(token) ||
    /[-@]/.test(token) ||
    /[A-Za-z]+\d|\d[A-Za-z]/.test(token)
  );
}

function isConcreteNameSpan(value: string): boolean {
  const normalized = normalizeForMatch(value);
  if (isGenericAnchor(normalized)) {
    return false;
  }
  return (
    /\b[A-Z0-9+#]{2,}\b/.test(value) ||
    /[-@]/.test(value) ||
    /\d/.test(value) ||
    value
      .split(/\s+/)
      .filter((token) => !isConnector(token))
      .some((token) => /^[A-Z][A-Za-z0-9+#.]*/.test(token))
  );
}

function normalizedWordCount(value: string): number {
  return normalizeForMatch(value).split(/\s+/).filter(Boolean).length;
}

function shouldRequireCompositeAnchor(value: string): boolean {
  return normalizedWordCount(value) <= 4;
}

function anchorKindForToken(token: string): PaperEvidenceAnchorKind {
  if (isNumberToken(token)) {
    return "numeric_or_detail_anchor";
  }
  const normalized = normalizeForMatch(token);
  if (DETAIL_TERMS.has(normalized)) {
    return "numeric_or_detail_anchor";
  }
  return isAcronymOrName(token) || /[-@]/.test(token) || /[A-Za-z]+\d|\d[A-Za-z]/.test(token)
    ? "paper_identity_anchor"
    : "claim_anchor";
}

export function extractPaperEvidenceConcreteAnchorGroups(
  query: string,
): ConcreteAnchorGroup[] {
  const groups: ConcreteAnchorGroup[] = [];
  const seen = new Set<string>();
  addKubernetesPspAnchorGroups(query, groups, seen);

  for (const term of extractNameSpans(query)) {
    if (/^kubernetes psp$/i.test(term.value)) {
      continue;
    }
    if (isConcreteNameSpan(term.value) && shouldRequireCompositeAnchor(term.value)) {
      addAnchorGroup(groups, seen, term.value, [term.value], "paper_identity_anchor", {
        allowLooseTokenMatch: true,
      });
    }
  }

  for (const token of concreteAnchorTokens(query)) {
    if (!isConcreteAnchorToken(token)) {
      continue;
    }
    addAnchorGroup(groups, seen, token, [token], anchorKindForToken(token));
  }

  for (const match of query.matchAll(/["'“‘]([^"'”’]{3,})["'”’]/g)) {
    if (isConcreteNameSpan(match[1])) {
      addAnchorGroup(groups, seen, match[1], [match[1]], "claim_anchor", {
        allowLooseTokenMatch: normalizedWordCount(match[1]) <= 6,
      });
    }
  }

  return groups.slice(0, 8);
}

function textContainsAnchorGroup(
  normalizedText: string,
  group: ConcreteAnchorGroup,
): boolean {
  const exactVariantMatched = group.variants.some((variant) => {
    if (isNumberToken(variant)) {
      return textContainsTerm(normalizedText, {
        value: variant,
        normalized: normalizeForMatch(variant),
        kind: "number",
      });
    }
    const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return (
      new RegExp(`(^|\\s)${escaped}(\\s|$)`).test(normalizedText) ||
      (variant.length >= 3 &&
        /^[a-z]+$/.test(variant) &&
        new RegExp(`(^|\\s)\\d+${escaped}(\\s|$)`).test(normalizedText))
    );
  });
  if (exactVariantMatched) {
    return true;
  }

  if (!group.allowLooseTokenMatch) {
    return false;
  }

  const words = group.label
    .split(/\s+/)
    .filter((word) => word.length > 1 && !isConnector(word));
  return (
    words.length > 1 &&
    words.every((word) => {
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(^|\\s)${escaped}(\\s|$)`).test(normalizedText);
    })
  );
}

function titleAcronym(value: string | null | undefined): string {
  const words = normalizeForMatch(value ?? "")
    .split(/\s+/)
    .filter((word) => word.length > 0 && !isConnector(word));
  if (words.length < 2) {
    return "";
  }
  return words.map((word) => word[0]).join("");
}

function candidateIdentityContainsAnchorGroup(
  normalizedCandidateIdentityText: string,
  title: string | null,
  group: ConcreteAnchorGroup,
): boolean {
  if (textContainsAnchorGroup(normalizedCandidateIdentityText, group)) {
    return true;
  }
  const acronym = titleAcronym(title);
  return acronym.length >= 2 && group.variants.includes(acronym);
}

function textContainsTerm(normalizedText: string, term: PaperEvidenceClaimTerm) {
  if (term.kind === "number") {
    const textNumberKeys = [
      ...normalizedText.matchAll(/\d+(?:\.\d+)?\s*%?/g),
    ].map((match) => normalizeNumber(match[0]));
    return textNumberKeys.includes(normalizeNumber(term.value));
  }

  return termVariants(term).some((variant) => {
    const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|\\s)${escaped}(\\s|$)`).test(normalizedText);
  });
}

function isConnector(token: string): boolean {
  return /^(and|for|of|the|to|with)$/i.test(token);
}

function extractNameSpans(query: string): PaperEvidenceClaimTerm[] {
  const rawTokens =
    query.match(/[A-Za-z][A-Za-z0-9+#]*(?:[-@][A-Za-z0-9+#]+)*/g) ?? [];
  const spans: PaperEvidenceClaimTerm[] = [];

  for (let index = 0; index < rawTokens.length; index += 1) {
    if (
      !isAcronymOrName(rawTokens[index]) ||
      CLAIM_STOPWORDS.has(rawTokens[index].toLowerCase())
    ) {
      continue;
    }
    let end = index + 1;
    while (
      end < rawTokens.length &&
      (isAcronymOrName(rawTokens[end]) ||
        (isConnector(rawTokens[end]) &&
          end + 1 < rawTokens.length &&
          isAcronymOrName(rawTokens[end + 1])))
    ) {
      end += 1;
    }

    const value = rawTokens.slice(index, end).join(" ");
    if (value.split(/\s+/).length > 1) {
      spans.push({
        value,
        normalized: normalizeForMatch(value),
        kind: "high_signal",
      });
    }
    index = end - 1;
  }

  return spans;
}

export function extractPaperEvidenceClaimTerms(
  query: string,
): PaperEvidenceClaimTerm[] {
  const terms: PaperEvidenceClaimTerm[] = [];

  for (const match of query.matchAll(/["'“‘]([^"'”’]{3,})["'”’]/g)) {
    terms.push({
      value: match[1],
      normalized: normalizeForMatch(match[1]),
      kind: "high_signal",
    });
  }

  terms.push(...extractNameSpans(query));

  for (const token of extractTokens(query)) {
    const normalized = normalizeForMatch(token);
    if (!normalized) {
      continue;
    }
    if (isNumberToken(token)) {
      terms.push({ value: token, normalized, kind: "number" });
      continue;
    }
    if (CLAIM_STOPWORDS.has(normalized) || CORPUS_META_TERMS.has(normalized)) {
      continue;
    }
    if (normalized.length < 4 && !isHighSignalToken(token)) {
      continue;
    }
    terms.push({
      value: token,
      normalized,
      kind: isHighSignalToken(token) ? "high_signal" : "term",
    });
  }

  return uniqueByNormalized(terms).slice(0, 12);
}

function isDetailSensitiveQuery(query: string): boolean {
  const normalizedTokens = extractTokens(query).map((token) =>
    normalizeForMatch(token),
  );
  const hasDetailTerms = normalizedTokens.some((token) =>
    DETAIL_TERMS.has(token),
  );
  if (
    isBroadPaperOverviewQuery(query) &&
    !isScopedDetailOverviewQuery(query, normalizedTokens)
  ) {
    return false;
  }
  return hasDetailTerms;
}

function isBroadPaperOverviewQuery(query: string): boolean {
  const normalized = normalizeForMatch(query);
  return (
    /\b(?:main|key|core|central)\s+claims?\b/.test(normalized) ||
    /\bcontributions?\b/.test(normalized) ||
    /\bwalk\s+(?:me\s+)?through\b/.test(normalized) ||
    /\bwhat\s+did\b.*\b(?:talk|cover|discuss)\b/.test(normalized) ||
    /\boverview\b|\bsummary\b|\bsummarize\b/.test(normalized)
  );
}

function isScopedDetailOverviewQuery(
  query: string,
  normalizedTokens: string[],
): boolean {
  const detailTokens = normalizedTokens.filter((token) =>
    DETAIL_TERMS.has(token),
  );
  if (detailTokens.length === 0) {
    return false;
  }

  const normalized = normalizeForMatch(query);
  const hasSpecificDetailTerm = detailTokens.some(
    (token) => token !== "result" && token !== "results",
  );
  if (hasSpecificDetailTerm) {
    return true;
  }

  return (
    /\b(?:summary|summarize|overview)\b.*\bresults?\b/.test(normalized) ||
    /\bresults?\b.*\b(?:summary|summarize|overview)\b/.test(normalized) ||
    /\bwalk\s+(?:me\s+)?through\b.*\bresults?\b/.test(normalized) ||
    /\bresults?\b.*\b(?:for|on|from|in|of|about)\b/.test(normalized)
  );
}

function chunkText(hit: PaperEvidenceChunkCandidate): string {
  return [hit.title, hit.snippet, hit.text, ...(hit.entity_labels ?? [])]
    .filter(Boolean)
    .join(" ");
}

function isPaperCard(hit: PaperEvidenceChunkCandidate): boolean {
  return /^\s*paper card\s*:/i.test(hit.text ?? hit.snippet);
}

export function isReferenceLikePaperEvidenceText(value: string): boolean {
  const normalized = normalizeWhitespace(value);
  if (!normalized) {
    return false;
  }

  const withoutSectionPrefix = normalized.replace(/^section:\s*/i, "");
  if (/^(references|bibliography|works cited)\b/i.test(withoutSectionPrefix)) {
    return true;
  }

  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 8);
  if (lines.length === 0) {
    return false;
  }
  if (/^(section:\s*)?(references|bibliography|works cited)\b/i.test(lines[0])) {
    return true;
  }

  const citationLikeLines = lines.filter((line) => {
    const hasCitationPrefix =
      /^\[\d+\]/.test(line) ||
      /^\d+\.\s+/.test(line) ||
      /^[A-Z][A-Za-z'-]+,\s+[A-Z]/.test(line) ||
      /^[A-Z][A-Za-z'-]+\s+et\s+al\./i.test(line);
    const hasReferenceSignal =
      /\b(19|20)\d{2}\b/.test(line) ||
      /\barxiv\b|\bdoi\b|https?:\/\//i.test(line);
    return hasCitationPrefix && hasReferenceSignal;
  });

  return lines.length >= 3 && citationLikeLines.length / lines.length >= 0.6;
}

function isReferenceLikeChunk(hit: PaperEvidenceChunkCandidate): boolean {
  return isReferenceLikePaperEvidenceText(hit.text ?? hit.snippet);
}

function isCitationIntentQuery(query: string): boolean {
  const normalized = normalizeForMatch(query);
  return (
    /\b(citation|citations|cite|cites|cited|reference|references|bibliography)\b/.test(
      normalized,
    ) ||
    /\brelated work\b/.test(normalized) ||
    /\bwhat papers\b.*\bcit/.test(normalized)
  );
}

function isPaperIdentityIntentQuery(query: string): boolean {
  const normalized = normalizeForMatch(query);
  return /\b(paper|study|work)\b/.test(normalized);
}

export function verifyPaperEvidenceChunks({
  query,
  candidateFeedItemIds,
  hits,
}: {
  query: string;
  candidateFeedItemIds: number[];
  hits: PaperEvidenceChunkCandidate[];
}): PaperEvidenceVerification {
  const terms = extractPaperEvidenceClaimTerms(query);
  const numberTerms = terms.filter((term) => term.kind === "number");
  const highSignalTerms = terms.filter((term) => term.kind === "high_signal");
  const concreteAnchorGroups = extractPaperEvidenceConcreteAnchorGroups(query);
  const detailSensitive = isDetailSensitiveQuery(query);
  const citationIntent = isCitationIntentQuery(query);
  const paperIdentityIntent = isPaperIdentityIntentQuery(query);

  const chunks = hits.map((hit): PaperEvidenceChunkVerification => {
    const identityAnchorGroups = concreteAnchorGroups.filter(
      (group) => group.kind === "paper_identity_anchor",
    );
    const claimDetailAnchorGroups = concreteAnchorGroups.filter(
      (group) => group.kind !== "paper_identity_anchor",
    );
    const normalizedText = normalizeForMatch(chunkText(hit));
    const normalizedTitle = normalizeForMatch(hit.title ?? "");
    const normalizedMetadata = normalizeForMatch(
      [hit.author_name, ...(hit.entity_labels ?? [])].filter(Boolean).join(" "),
    );
    const normalizedCandidateIdentity = normalizeForMatch(
      [hit.title, hit.author_name].filter(Boolean).join(" "),
    );
    const normalizedChunk = normalizeForMatch(hit.text ?? "");
    const normalizedSnippet = normalizeForMatch(hit.snippet ?? "");
    const matchedTerms = terms
      .filter((term) => textContainsTerm(normalizedText, term))
      .map((term) => term.normalized);
    const matchedNumbers = numberTerms
      .filter((term) => textContainsTerm(normalizedText, term))
      .map((term) => term.normalized);
    const coverage = terms.length === 0 ? 0 : matchedTerms.length / terms.length;
    const matchedHighSignal = highSignalTerms.some((term) =>
      matchedTerms.includes(term.normalized),
    );
    const matchedAnchorGroups = concreteAnchorGroups
      .filter((group) => textContainsAnchorGroup(normalizedText, group))
      .map((group) => group.label);
    const missingAnchorGroups = concreteAnchorGroups
      .filter((group) => !matchedAnchorGroups.includes(group.label))
      .map((group) => group.label);
    const anchorGroupsByKind = {
      paper_identity_anchor: identityAnchorGroups.map((group) => group.label),
      claim_anchor: concreteAnchorGroups
        .filter((group) => group.kind === "claim_anchor")
        .map((group) => group.label),
      numeric_or_detail_anchor: concreteAnchorGroups
        .filter((group) => group.kind === "numeric_or_detail_anchor")
        .map((group) => group.label),
    };
    const identityAnchorMatches = {
      candidate: identityAnchorGroups
        .filter((group) =>
          candidateIdentityContainsAnchorGroup(
            normalizedCandidateIdentity,
            hit.title,
            group,
          ),
        )
        .map((group) => group.label),
      title: identityAnchorGroups
        .filter((group) => textContainsAnchorGroup(normalizedTitle, group))
        .map((group) => group.label),
      metadata: identityAnchorGroups
        .filter((group) => textContainsAnchorGroup(normalizedMetadata, group))
        .map((group) => group.label),
      chunk: identityAnchorGroups
        .filter((group) => textContainsAnchorGroup(normalizedChunk, group))
        .map((group) => group.label),
      snippet: identityAnchorGroups
        .filter((group) => textContainsAnchorGroup(normalizedSnippet, group))
        .map((group) => group.label),
    };
    const claimDetailAnchorMatches = claimDetailAnchorGroups
      .filter((group) => textContainsAnchorGroup(normalizedText, group))
      .map((group) => group.label);
    const paperCard = isPaperCard(hit);
    const referenceLike = isReferenceLikeChunk(hit);
    const hasExactNumbers =
      numberTerms.length === 0 || matchedNumbers.length === numberTerms.length;

    let supports = false;
    let demotionReason: string | null = null;
    let reason = "insufficient required term coverage";
    if (terms.length === 0) {
      reason = "no verifiable claim terms";
    } else if (detailSensitive) {
      supports =
        !paperCard &&
        terms.length >= 3 &&
        matchedTerms.length >= 3 &&
        coverage >= 0.6 &&
        hasExactNumbers;
      reason = supports
        ? "detail-sensitive claim supported"
        : paperCard
          ? "paper card cannot support detail-sensitive claims"
          : "detail-sensitive claim lacks term or exact-number support";
    } else {
      supports =
        highSignalTerms.length > 0 && !matchedHighSignal
          ? false
          : (matchedTerms.length >= 2 && coverage >= 0.5) ||
            (matchedHighSignal && coverage >= 0.35);
      reason = supports
        ? "claim terms supported"
        : highSignalTerms.length > 0 && !matchedHighSignal
          ? "high-signal claim terms were not matched"
          : reason;
    }

    if (supports && missingAnchorGroups.length > 0) {
      supports = false;
      demotionReason = missingAnchorGroups.some((label) =>
        identityAnchorGroups.some((group) => group.label === label),
      )
        ? "missing concrete identity"
        : "missing claim evidence";
      reason = `concrete anchors not matched: ${missingAnchorGroups.join(", ")}`;
    }

    if (supports && referenceLike && !citationIntent) {
      supports = false;
      demotionReason = "reference-only evidence";
      reason =
        "weak/reference_evidence: reference-like chunk cannot support a substantive claim";
    }

    if (
      supports &&
      paperIdentityIntent &&
      identityAnchorGroups.length > 0 &&
      identityAnchorMatches.candidate.length === 0 &&
      !citationIntent
    ) {
      supports = false;
      demotionReason = "missing candidate paper identity";
      reason =
        "paper identity anchors matched retrieved text but not candidate paper identity";
    }

    return {
      hit,
      supports,
      matchedTerms,
      matchedNumbers,
      matchedAnchorGroups,
      missingAnchorGroups,
      anchorGroupsByKind,
      identityAnchorMatches,
      claimDetailAnchorMatches,
      coverage,
      isPaperCard: paperCard,
      isReferenceLike: referenceLike,
      demotionReason,
      reason,
    };
  });

  const supportingChunkIds = chunks
    .filter((chunk) => chunk.supports)
    .map((chunk) => chunk.hit.id);
  const relatedChunkIds = chunks
    .filter((chunk) => !chunk.supports)
    .map((chunk) => chunk.hit.id);
  const weakReferenceChunkIds = chunks
    .filter((chunk) => chunk.isReferenceLike && chunk.reason.includes("weak/reference_evidence"))
    .map((chunk) => chunk.hit.id);
  const uniqueCandidateFeedItemIds = [...new Set(candidateFeedItemIds)];

  let metadata: PaperEvidenceMetadata;
  if (supportingChunkIds.length > 0) {
    metadata = {
      status: "supports",
      candidate_feed_item_ids: uniqueCandidateFeedItemIds,
      supporting_chunk_ids: supportingChunkIds,
      related_chunk_ids: relatedChunkIds,
      reason: "retrieved chunk(s) directly support the requested paper claim",
    };
  } else if (weakReferenceChunkIds.length > 0) {
    metadata = {
      status: "weak/reference_evidence",
      candidate_feed_item_ids: uniqueCandidateFeedItemIds,
      supporting_chunk_ids: [],
      related_chunk_ids: relatedChunkIds,
      weak_reference_chunk_ids: weakReferenceChunkIds,
      reason:
        "reference-like chunk(s) matched the claim, but references cannot substantively support it",
    };
  } else if (uniqueCandidateFeedItemIds.length > 0) {
    metadata = {
      status: "paper_related_only",
      candidate_feed_item_ids: uniqueCandidateFeedItemIds,
      supporting_chunk_ids: [],
      related_chunk_ids: relatedChunkIds,
      reason:
        "candidate paper(s) were found, but retrieved chunks do not support the requested claim",
    };
  } else {
    metadata = {
      status: "unsupported",
      candidate_feed_item_ids: [],
      supporting_chunk_ids: [],
      related_chunk_ids: [],
      reason: "no candidate paper was found for the requested claim",
    };
  }

  return { metadata, chunks };
}
