import type { MemorySearchChunkHit } from "@/lib/schema";

const GENERIC_EVIDENCE_TERMS = new Set([
  "agent",
  "agents",
  "benchmark",
  "benchmarks",
  "framework",
  "frameworks",
  "method",
  "model",
  "models",
  "paper",
  "papers",
  "result",
  "results",
  "system",
  "systems",
]);

const STOPWORDS = new Set([
  "about",
  "after",
  "against",
  "also",
  "among",
  "before",
  "between",
  "does",
  "from",
  "have",
  "into",
  "only",
  "over",
  "report",
  "reports",
  "show",
  "shows",
  "that",
  "their",
  "these",
  "this",
  "through",
  "under",
  "using",
  "what",
  "when",
  "where",
  "which",
  "with",
]);

export type EvidenceClaimProfile = {
  query: string;
  claimEvidenceQueries: string[];
  quotedSpans: string[];
  numbers: string[];
  entities: string[];
  acronyms: string[];
  hyphenatedTerms: string[];
  highSignalTerms: string[];
  genericTerms: string[];
};

export type EvidenceChunkScore = {
  score: number;
  matchedNumbers: string[];
  matchedEntities: string[];
  matchedSpans: string[];
  matchedAcronyms: string[];
  matchedHyphenatedTerms: string[];
  matchedHighSignalTerms: string[];
  matchedGenericTerms: string[];
  coverage: number;
  density: number;
  penaltyCount: number;
};

export type RerankedEvidenceChunkHit = MemorySearchChunkHit & {
  contentEvidenceScore: EvidenceChunkScore;
};

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeForPhraseMatch(value: string): string {
  return normalizeWhitespace(
    value
      .toLowerCase()
      .replace(/\bpercent\b/g, "%")
      .replace(/[‐‑‒–—]/g, "-")
      .replace(/[@/_-]/g, " ")
      .replace(/[^a-z0-9+.%\s]/g, " "),
  );
}

function phraseVariants(value: string): string[] {
  const normalized = normalizeForPhraseMatch(value);
  const variants = new Set([normalized]);
  variants.add(normalized.replace(/\s+/g, " "));
  variants.add(normalized.replace(/\b(\d+(?:\.\d+)?)\s+%\b/g, "$1%"));
  variants.add(normalized.replace(/\b(\d+(?:\.\d+)?)%\b/g, "$1 %"));
  return [...variants].filter(Boolean);
}

function containsTerm(normalizedText: string, term: string): boolean {
  return phraseVariants(term).some((variant) => {
    if (!variant) {
      return false;
    }
    return normalizedText.includes(variant);
  });
}

function uniquePreservingOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values.map(normalizeWhitespace).filter(Boolean)) {
    const key = normalizeForPhraseMatch(value);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(value);
  }
  return result;
}

function extractQuotedSpans(value: string): string[] {
  return [...value.matchAll(/["'“‘]([^"'”’]{3,})["'”’]/g)].map(
    (match) => match[1],
  );
}

function extractNumbers(value: string): string[] {
  return [
    ...value.matchAll(/\b\d+(?:\.\d+)?\s*(?:%|percent)?/gi),
  ].map((match) => normalizeWhitespace(match[0]));
}

function numberKey(value: string): string {
  return value.toLowerCase().replace(/\s*percent\b/g, "%").replace(/\s+/g, "");
}

function extractTokens(value: string): string[] {
  return (
    value.match(/[A-Za-z][A-Za-z0-9+#]*(?:[-@][A-Za-z0-9+#]+)*|\d+(?:\.\d+)?%?/g) ??
    []
  );
}

function isConnector(token: string): boolean {
  return /^(and|for|in|of|on|the|to|with)$/i.test(token);
}

function isAcronym(token: string): boolean {
  return /^[A-Z0-9+#]{2,}(?:[-@][A-Za-z0-9+#]+)*$/.test(token);
}

function isProper(token: string): boolean {
  return (
    /^[A-Z][A-Za-z0-9+#]*(?:[-@][A-Za-z0-9+#]+)*$/.test(token) &&
    !STOPWORDS.has(token.toLowerCase())
  );
}

function extractEntitySpans(value: string): string[] {
  const tokens = extractTokens(value);
  const spans: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (!isProper(tokens[index]) && !isAcronym(tokens[index])) {
      continue;
    }
    let end = index + 1;
    while (
      end < tokens.length &&
      (isProper(tokens[end]) ||
        isAcronym(tokens[end]) ||
        (isConnector(tokens[end]) &&
          end + 1 < tokens.length &&
          (isProper(tokens[end + 1]) || isAcronym(tokens[end + 1]))))
    ) {
      end += 1;
    }
    spans.push(tokens.slice(index, end).join(" "));
    index = end - 1;
  }
  return spans;
}

function extractHyphenatedTerms(value: string): string[] {
  return (
    value.match(/\b[A-Za-z0-9+#]+(?:[-@][A-Za-z0-9+#]+)+\b/g) ?? []
  );
}

function extractHighSignalTerms(value: string): string[] {
  return extractTokens(value)
    .map((token) => token.toLowerCase())
    .filter((token) => {
      return (
        token.length >= 4 &&
        !STOPWORDS.has(token) &&
        !GENERIC_EVIDENCE_TERMS.has(token) &&
        !/^\d+(?:\.\d+)?%?$/.test(token)
      );
    });
}

function isEntityLikePhrase(value: string): boolean {
  const tokens = extractTokens(value);
  return (
    tokens.length > 0 &&
    tokens.every((token) => isProper(token) || isAcronym(token) || isConnector(token)) &&
    tokens.some((token) => isProper(token) || isAcronym(token))
  );
}

export function buildEvidenceClaimProfile(
  query: string,
  claimEvidenceQueries: string[],
): EvidenceClaimProfile {
  const profileText = [query, ...claimEvidenceQueries].join(" ");
  const tokens = extractTokens(profileText);
  const acronyms = tokens.filter(isAcronym);
  const genericTerms = tokens
    .map((token) => token.toLowerCase())
    .filter((token) => GENERIC_EVIDENCE_TERMS.has(token));

  return {
    query,
    claimEvidenceQueries,
    quotedSpans: uniquePreservingOrder(extractQuotedSpans(query)),
    numbers: uniquePreservingOrder(extractNumbers(profileText)),
    entities: uniquePreservingOrder([
      ...extractEntitySpans(profileText),
      ...claimEvidenceQueries.filter(isEntityLikePhrase),
    ]),
    acronyms: uniquePreservingOrder(acronyms),
    hyphenatedTerms: uniquePreservingOrder(extractHyphenatedTerms(profileText)),
    highSignalTerms: uniquePreservingOrder(extractHighSignalTerms(profileText)),
    genericTerms: uniquePreservingOrder([
      ...genericTerms,
      ...GENERIC_EVIDENCE_TERMS,
    ]),
  };
}

function matchedTerms(normalizedText: string, terms: string[]): string[] {
  return terms.filter((term) => containsTerm(normalizedText, term));
}

function matchedNumbers(normalizedText: string, numbers: string[]): string[] {
  const textNumberKeys = new Set(
    extractNumbers(normalizedText).map((number) => numberKey(number)),
  );
  return numbers.filter((number) => textNumberKeys.has(numberKey(number)));
}

function termPosition(normalizedText: string, term: string): number | null {
  const positions = phraseVariants(term)
    .map((variant) => normalizedText.indexOf(variant))
    .filter((position) => position >= 0);
  if (positions.length === 0) {
    return null;
  }
  return Math.min(...positions);
}

function sameChunkDensity(
  normalizedText: string,
  matchedSpecificTerms: string[],
): number {
  const positions = matchedSpecificTerms
    .map((term) => termPosition(normalizedText, term))
    .filter((position): position is number => position != null)
    .sort((a, b) => a - b);
  if (positions.length < 2) {
    return 0;
  }
  const span = positions[positions.length - 1] - positions[0];
  if (span <= 240) {
    return 1;
  }
  if (span <= 600) {
    return 0.5;
  }
  return 0.25;
}

export function scoreEvidenceChunkForClaim(
  profile: EvidenceClaimProfile,
  chunkText: string,
): EvidenceChunkScore {
  const normalizedText = normalizeForPhraseMatch(chunkText);
  const matchedSpans = matchedTerms(normalizedText, profile.quotedSpans);
  const matchedNumberValues = matchedNumbers(normalizedText, profile.numbers);
  const matchedEntities = matchedTerms(normalizedText, profile.entities);
  const matchedAcronyms = matchedTerms(normalizedText, profile.acronyms);
  const matchedHyphenatedTerms = matchedTerms(
    normalizedText,
    profile.hyphenatedTerms,
  );
  const matchedHighSignalTerms = matchedTerms(
    normalizedText,
    profile.highSignalTerms,
  );
  const matchedGenericTerms = matchedTerms(normalizedText, profile.genericTerms);
  const highSignalDenominator = Math.max(profile.highSignalTerms.length, 1);
  const coverage = matchedHighSignalTerms.length / highSignalDenominator;
  const matchedSpecificTerms = uniquePreservingOrder([
    ...matchedSpans,
    ...matchedNumberValues,
    ...matchedEntities,
    ...matchedAcronyms,
    ...matchedHyphenatedTerms,
    ...matchedHighSignalTerms,
  ]);
  const density = sameChunkDensity(normalizedText, matchedSpecificTerms);
  const genericOnly =
    matchedSpecificTerms.length === 0 && matchedGenericTerms.length > 0;
  const penaltyCount = genericOnly ? matchedGenericTerms.length + 1 : 0;
  const rawScore =
    matchedSpans.length * 8 +
    matchedNumberValues.length * 5 +
    matchedEntities.length * 4 +
    matchedAcronyms.length * 3 +
    matchedHyphenatedTerms.length * 4 +
    matchedHighSignalTerms.length * 1.25 +
    coverage * 6 +
    density * 3 -
    penaltyCount * 3;

  return {
    score: Math.max(0, Number(rawScore.toFixed(3))),
    matchedNumbers: matchedNumberValues,
    matchedEntities,
    matchedSpans,
    matchedAcronyms,
    matchedHyphenatedTerms,
    matchedHighSignalTerms,
    matchedGenericTerms,
    coverage: Number(coverage.toFixed(3)),
    density,
    penaltyCount,
  };
}

export function rerankEvidenceChunksForClaim({
  query,
  claimEvidenceQueries,
  hits,
  candidateFeedItemIds,
}: {
  query: string;
  claimEvidenceQueries: string[];
  hits: MemorySearchChunkHit[];
  candidateFeedItemIds: number[];
}): RerankedEvidenceChunkHit[] {
  const profile = buildEvidenceClaimProfile(query, claimEvidenceQueries);
  const candidateOrder = new Map(
    candidateFeedItemIds.map((feedItemId, index) => [feedItemId, index]),
  );
  const deduped = new Map<number, { hit: MemorySearchChunkHit; index: number }>();
  for (const [index, hit] of hits.entries()) {
    if (deduped.has(hit.id)) {
      continue;
    }
    deduped.set(hit.id, { hit, index });
  }

  return [...deduped.values()]
    .map(({ hit, index }) => ({
      ...hit,
      contentEvidenceScore: scoreEvidenceChunkForClaim(profile, hit.snippet),
      __stableIndex: index,
    }))
    .sort((a, b) => {
      const aCandidateOrder =
        candidateOrder.get(a.feed_item_id) ?? Number.MAX_SAFE_INTEGER;
      const bCandidateOrder =
        candidateOrder.get(b.feed_item_id) ?? Number.MAX_SAFE_INTEGER;
      if (aCandidateOrder !== bCandidateOrder) {
        return aCandidateOrder - bCandidateOrder;
      }
      if (b.contentEvidenceScore.score !== a.contentEvidenceScore.score) {
        return b.contentEvidenceScore.score - a.contentEvidenceScore.score;
      }
      return a.__stableIndex - b.__stableIndex;
    })
    .map((hit) => {
      const { __stableIndex, ...rerankedHit } = hit;
      void __stableIndex;
      return rerankedHit;
    });
}
