import type {
  AlphaxivProviderMeta,
  FeedItemInsert,
  PaperMeta,
} from "../schema";
import { fetchPaperFullText, pLimit } from "./paper-full-text";

const ALPHAXIV_FEED_URL = "https://api.alphaxiv.org/papers/v3/feed";
const PAGE_SIZE = 50;
const MAX_PAPERS = 20;
const FULL_TEXT_CONCURRENCY = 5;
const REQUEST_TIMEOUT_MS = 15_000;

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const AI_ARXIV_CATEGORIES = new Set([
  "cs.AI",
  "cs.LG",
  "cs.CL",
  "cs.CV",
  "cs.NE",
  "stat.ML",
]);

const CORE_AI_ARXIV_CATEGORIES = new Set(["cs.AI", "cs.CL", "cs.LG"]);

const AI_RELEVANCE_PATTERNS = [
  /\bagents?\b/i,
  /\bbenchmarks?\b/i,
  /\bcod(e|ing|er|ex)\b/i,
  /\bevals?\b/i,
  /\bevaluat(e|ion|ing)\b/i,
  /\bfoundation models?\b/i,
  /\bgenerative\b/i,
  /\blanguage models?\b/i,
  /\bLLMs?\b/i,
  /\bmemory\b/i,
  /\bmultimodal\b/i,
  /\breason(ing|er|ers)?\b/i,
  /\bretriev(al|e|ing)\b/i,
  /\bRAG\b/i,
  /\btools?\b/i,
  /\btransformers?\b/i,
];

interface AlphaxivAuthor {
  full_name: string;
  username?: string | null;
}

interface AlphaxivPaperSummary {
  summary?: string;
  originalProblem?: string[];
  solution?: string[];
  keyInsights?: string[];
  results?: string[];
}

interface AlphaxivPaper {
  universal_paper_id?: string;
  canonical_id?: string;
  title?: string;
  abstract?: string;
  paper_summary?: AlphaxivPaperSummary;
  publication_date?: string;
  first_publication_date?: string;
  topics?: string[];
  authors?: string[];
  full_authors?: AlphaxivAuthor[];
  metrics?: {
    visits_count?: { all?: number; last_7_days?: number };
    total_votes?: number;
    public_total_votes?: number;
  };
  github_url?: string | null;
  github_stars?: number | null;
}

interface AlphaxivFeedResponse {
  papers?: AlphaxivPaper[];
  page?: number;
}

export interface FetchAlphaxivContentOptions {
  fetchFullText?: boolean;
}

function buildFeedUrl(): string {
  // URLSearchParams encodes " " as "+" (form-urlencoded). alphaXiv's Zod
  // validator matches the literal string "7 Days", so we need %20.
  return (
    `${ALPHAXIV_FEED_URL}` +
    `?pageNum=1&pageSize=${PAGE_SIZE}` +
    `&sort=Hot&interval=${encodeURIComponent("7 Days")}`
  );
}

function publishedThisYear(paper: AlphaxivPaper): boolean {
  const publishedAt = paper.publication_date ?? paper.first_publication_date;
  if (!publishedAt) return false;

  const published = new Date(publishedAt);
  if (Number.isNaN(published.getTime())) return false;

  return published.getUTCFullYear() === new Date().getUTCFullYear();
}

function searchablePaperText(paper: AlphaxivPaper): string {
  const summary = paper.paper_summary;
  return [
    paper.title,
    paper.abstract,
    summary?.summary,
    ...(summary?.originalProblem ?? []),
    ...(summary?.solution ?? []),
    ...(summary?.keyInsights ?? []),
    ...(summary?.results ?? []),
    ...(paper.topics ?? []),
  ]
    .filter(Boolean)
    .join("\n");
}

function isAiRelevantPaper(paper: AlphaxivPaper): boolean {
  if (!paper.universal_paper_id || !paper.abstract) return false;
  if (!publishedThisYear(paper)) return false;

  const topics = paper.topics ?? [];
  if (!topics.some((t) => AI_ARXIV_CATEGORIES.has(t))) return false;
  if (topics.some((t) => CORE_AI_ARXIV_CATEGORIES.has(t))) return true;

  const text = searchablePaperText(paper);
  return AI_RELEVANCE_PATTERNS.some((pattern) => pattern.test(text));
}

export async function fetchAlphaxivContent(
  options: FetchAlphaxivContentOptions = {},
): Promise<FeedItemInsert[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);

  let body: AlphaxivFeedResponse;
  try {
    const res = await fetch(buildFeedUrl(), {
      signal: ctrl.signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      console.error(`alphaXiv feed returned ${res.status}`);
      return [];
    }
    body = (await res.json()) as AlphaxivFeedResponse;
  } catch (err) {
    console.error(
      "Failed to fetch alphaXiv feed:",
      err instanceof Error ? err.message : err,
    );
    return [];
  } finally {
    clearTimeout(timer);
  }

  const papers = body.papers ?? [];
  if (!papers.length) return [];

  const aiPapers = papers.filter(isAiRelevantPaper);

  const baseInserts = aiPapers
    .sort(
      (a, b) =>
        (b.metrics?.public_total_votes ?? 0) -
        (a.metrics?.public_total_votes ?? 0),
    )
    .slice(0, MAX_PAPERS)
    .map((paper) => buildInsert(paper));

  if (options.fetchFullText === false) {
    return baseInserts.map((insert) => ({
      ...insert,
      full_text: null,
      full_text_source: null,
    }));
  }

  const limit = pLimit(FULL_TEXT_CONCURRENCY);
  const fullTexts = await Promise.all(
    baseInserts.map((ins) =>
      limit(() => fetchPaperFullText(ins.external_id)),
    ),
  );

  return baseInserts.map((insert, i) => ({
    ...insert,
    full_text: fullTexts[i]?.text ?? null,
    full_text_source: fullTexts[i]?.source ?? null,
  }));
}

function buildInsert(paper: AlphaxivPaper): FeedItemInsert {
  const arxivId = paper.universal_paper_id!;
  const fullAuthors = paper.full_authors ?? [];
  const authorNames = paper.authors ?? fullAuthors.map((a) => a.full_name);
  const authorName = authorNames.slice(0, 3).join(", ");
  const topics = paper.topics ?? [];

  const votes = paper.metrics?.public_total_votes ?? 0;
  const visitsAll = paper.metrics?.visits_count?.all ?? 0;
  const visitsLast7Days = paper.metrics?.visits_count?.last_7_days ?? 0;
  const summary = paper.paper_summary?.summary ?? null;
  const aiKeywords = topics.filter(
    (t) => !AI_ARXIV_CATEGORIES.has(t) && t !== "Computer Science",
  );

  const alphaProvider: AlphaxivProviderMeta = {
    votes,
    visitsAll,
    visitsLast7Days,
    githubUrl: paper.github_url ?? null,
    githubStars: paper.github_stars ?? null,
    topics,
    summary,
    originalProblem: paper.paper_summary?.originalProblem ?? null,
    solution: paper.paper_summary?.solution ?? null,
    keyInsights: paper.paper_summary?.keyInsights ?? null,
    results: paper.paper_summary?.results ?? null,
  };

  const paperMeta: PaperMeta = {
    upvotes: votes,
    numComments: 0,
    githubRepo: paper.github_url ?? null,
    githubStars: paper.github_stars ?? null,
    aiSummary: summary,
    aiKeywords: aiKeywords.length > 0 ? aiKeywords : null,
    authors: fullAuthors.map((a) => ({
      name: a.full_name,
      ...(a.username ? { user: a.username } : {}),
    })),
    providers: { alphaxiv: alphaProvider },
  };

  return {
    source_type: "paper" as const,
    external_id: arxivId,
    title: paper.title ?? null,
    content: paper.abstract!,
    url: `https://arxiv.org/abs/${arxivId}`,
    author_name: authorName,
    published_at:
      paper.publication_date ?? paper.first_publication_date ?? null,
    paper_meta: paperMeta,
  };
}
