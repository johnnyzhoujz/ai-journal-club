import type {
  PaperEvidenceCardDraft,
  PaperEvidenceSectionDraft,
} from "@/lib/paper-evidence-layer";
import type { PaperMeta } from "@/lib/schema";

const MAX_PROFILE_TEXT_CHARS = 1_500;
const MAX_PROFILE_CLAIMS = 6;
const MAX_PROFILE_TERMS = 24;
const MAX_PROFILE_ARRAY_VALUE_CHARS = 120;

export interface PaperReaderProfileFeedItem {
  id: number;
  title: string | null;
  content: string;
  paper_meta: PaperMeta | null;
}

export interface PaperReaderProfileDraft {
  stableKey: string;
  feedItemId: number;
  sourceHash: string;
  profileText: string;
  titleAliases: string[];
  keyphrases: string[];
  identityAnchors: string[];
  parserVersion: string;
  extractorVersion: string;
}

function normalizeFlat(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxChars: number): string {
  const normalized = normalizeFlat(value);
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd();
}

function unique(values: Array<string | null | undefined>, limit = MAX_PROFILE_TERMS) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = truncate(value ?? "", MAX_PROFILE_ARRAY_VALUE_CHARS);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
    if (result.length >= limit) {
      break;
    }
  }
  return result;
}

function sectionLabel(section: PaperEvidenceSectionDraft): string | null {
  return section.sectionPath.at(-1) ?? section.sectionType;
}

export function buildPaperReaderProfileDraft({
  item,
  sourceHash,
  sections,
  cards,
  parserVersion,
  extractorVersion,
}: {
  item: PaperReaderProfileFeedItem;
  sourceHash: string;
  sections: PaperEvidenceSectionDraft[];
  cards: PaperEvidenceCardDraft[];
  parserVersion: string;
  extractorVersion: string;
}): PaperReaderProfileDraft {
  const title = normalizeFlat(item.title);
  const abstract = normalizeFlat(item.content);
  const topCards = cards.slice(0, MAX_PROFILE_CLAIMS);
  const providerSummary = normalizeFlat(item.paper_meta?.aiSummary ?? null);
  const providerKeywords = item.paper_meta?.aiKeywords ?? [];
  const authorNames = item.paper_meta?.authors?.map((author) => author.name) ?? [];
  const cardTerms = topCards.flatMap((card) => [
    ...card.entities,
    ...card.methods,
    ...card.datasets,
    ...card.metrics,
    ...card.aliases,
  ]);

  const titleAliases = unique([
    title,
    item.paper_meta?.githubRepo ?? null,
    ...authorNames,
  ]);
  const keyphrases = unique([
    ...providerKeywords,
    ...cardTerms,
    ...sections.map(sectionLabel),
  ]);
  const identityAnchors = unique([
    title,
    ...topCards.flatMap((card) => card.aliases),
    ...topCards.flatMap((card) => card.entities),
  ]);

  const profileLines = [
    title ? `Title: ${title}` : null,
    abstract ? `Abstract: ${truncate(abstract, 520)}` : null,
    providerSummary ? `Provider summary: ${truncate(providerSummary, 420)}` : null,
    keyphrases.length > 0 ? `Keyphrases: ${keyphrases.join(", ")}` : null,
    ...topCards.map((card) => `Evidence: ${truncate(card.claim, 260)}`),
  ].filter((line): line is string => Boolean(line));

  return {
    stableKey: `paper-profile:${item.id}:${sourceHash.slice(0, 16)}`,
    feedItemId: item.id,
    sourceHash,
    profileText: truncate(profileLines.join("\n"), MAX_PROFILE_TEXT_CHARS),
    titleAliases,
    keyphrases,
    identityAnchors,
    parserVersion,
    extractorVersion,
  };
}
