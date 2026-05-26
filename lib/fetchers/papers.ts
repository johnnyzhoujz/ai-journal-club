import type {
  FeedItemInsert,
  HFPaperProviderMeta,
  PaperMeta,
} from "../schema";
import { fetchPaperFullText, pLimit } from "./paper-full-text";

const HF_DAILY_PAPERS_URL = "https://huggingface.co/api/daily_papers";
const FULL_TEXT_CONCURRENCY = 5;

export interface FetchPapersContentOptions {
  date?: string | Date;
  fetchFullText?: boolean;
  maxPapers?: number;
  currentYearOnly?: boolean;
}

interface HFAuthor {
  name: string;
  user?: { username: string };
}

interface HFPaper {
  paper: {
    id: string;
    title: string;
    summary: string;
    publishedAt: string | null;
    authors: HFAuthor[];
  };
  title: string;
  upvotes: number;
  numComments: number;
  githubRepo?: string | null;
  githubStars?: number | null;
  ai_summary?: string | null;
  ai_keywords?: string[] | null;
}

function formatDate(date: string | Date): string {
  return typeof date === "string" ? date : date.toISOString().slice(0, 10);
}

function isPublishedThisYear(paper: HFPaper): boolean {
  if (!paper.paper.publishedAt) return false;
  const publishedAt = new Date(paper.paper.publishedAt);
  if (Number.isNaN(publishedAt.getTime())) return false;
  return publishedAt.getUTCFullYear() === new Date().getUTCFullYear();
}

export async function fetchPapersContent(
  options: FetchPapersContentOptions = {},
): Promise<FeedItemInsert[]> {
  try {
    const fetchDate =
      options.date ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
    const dateStr = formatDate(fetchDate);

    const res = await fetch(`${HF_DAILY_PAPERS_URL}?date=${dateStr}`);
    if (!res.ok) {
      console.error(`HF Daily Papers API returned ${res.status}`);
      return [];
    }

    const papers: HFPaper[] = await res.json();
    if (!papers.length) return [];

    const eligiblePapers = options.currentYearOnly
      ? papers.filter(isPublishedThisYear)
      : papers;
    const sortedPapers = eligiblePapers.sort((a, b) => b.upvotes - a.upvotes);
    const selectedPapers =
      options.maxPapers && options.maxPapers > 0
        ? sortedPapers.slice(0, options.maxPapers)
        : sortedPapers;

    const baseInserts = selectedPapers.map((entry) => {
      const { paper } = entry;
      const authors = paper.authors || [];
      const authorName = authors
        .slice(0, 3)
        .map((a) => a.name)
        .join(", ");

      const hfProvider: HFPaperProviderMeta = {
        upvotes: entry.upvotes,
        numComments: entry.numComments,
        githubRepo: entry.githubRepo ?? null,
        githubStars: entry.githubStars ?? null,
        aiSummary: entry.ai_summary ?? null,
        aiKeywords: entry.ai_keywords ?? null,
      };

      const paperMeta: PaperMeta = {
        upvotes: entry.upvotes,
        numComments: entry.numComments,
        githubRepo: entry.githubRepo ?? null,
        githubStars: entry.githubStars ?? null,
        aiSummary: entry.ai_summary ?? null,
        aiKeywords: entry.ai_keywords ?? null,
        authors: authors.map((a) => ({
          name: a.name,
          ...(a.user ? { user: a.user.username } : {}),
        })),
        providers: { hf: hfProvider },
      };

      return {
        source_type: "paper" as const,
        external_id: paper.id,
        title: entry.title || paper.title,
        content: paper.summary,
        url: `https://arxiv.org/abs/${paper.id}`,
        author_name: authorName,
        published_at: paper.publishedAt ?? null,
        paper_meta: paperMeta,
      };
    });

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
  } catch (err) {
    console.error("Failed to fetch papers:", err);
    return [];
  }
}
