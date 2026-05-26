import { sql } from "@/lib/db";
import type { FeedItemSourceType, SearchResult } from "@/lib/schema";

export type ArchiveSearchSource = FeedItemSourceType | "all";

export interface ArchiveSearchParams {
  query: string;
  source: ArchiveSearchSource;
  after: string | null;
  before: string | null;
  limit: number;
}

export interface ArchiveSearchToolResult {
  id: number;
  source_type: FeedItemSourceType;
  title: string | null;
  author_name: string;
  url: string;
  published_at: string | null;
  snippet: string;
}

export interface ArchiveListParams {
  source: ArchiveSearchSource;
  author: string | null;
  after: string | null;
  before: string | null;
  limit: number;
  offset: number;
}

export interface ArchiveListToolResult {
  id: number;
  source_type: FeedItemSourceType;
  title: string | null;
  author_name: string;
  author_handle: string | null;
  url: string;
  published_at: string | null;
  content_excerpt: string;
}

interface ArchiveSearchRow {
  id: number;
  source_type: FeedItemSourceType;
  title: string | null;
  author_name: string;
  url: string;
  published_at: string | null;
  snippet: string;
}

interface ArchiveListRow {
  id: number;
  source_type: FeedItemSourceType;
  title: string | null;
  author_name: string;
  author_handle: string | null;
  url: string;
  published_at: string | null;
  content: string;
  total_count: number | string;
}

export interface ArchiveListForToolResult {
  results: ArchiveListToolResult[];
  total_count: number;
  returned_count: number;
  offset: number;
  has_more: boolean;
}

export const VALID_ARCHIVE_SEARCH_SOURCES: readonly ArchiveSearchSource[] = [
  "all",
  "tweet",
  "podcast",
  "newsletter",
  "paper",
];

export const ARCHIVE_SEARCH_DOCUMENT_SQL =
  "COALESCE(title, '') || ' ' || COALESCE(author_name, '') || ' ' || content";

export const ARCHIVE_SEARCH_VECTOR_SQL =
  `to_tsvector('english', ${ARCHIVE_SEARCH_DOCUMENT_SQL})`;

const RESEARCH_SNIPPET_OPTIONS =
  "MaxFragments=2, MaxWords=30, MinWords=15, StartSel=<b>, StopSel=</b>";
const TOOL_SNIPPET_START = "__archive_snippet_start__";
const TOOL_SNIPPET_END = "__archive_snippet_end__";
const TOOL_SNIPPET_OPTIONS = [
  "MaxFragments=2",
  "MaxWords=30",
  "MinWords=15",
  `StartSel=${TOOL_SNIPPET_START}`,
  `StopSel=${TOOL_SNIPPET_END}`,
].join(", ");

function buildArchiveSearchTemplate(snippetOptions: string): TemplateStringsArray {
  const strings = [
    `SELECT id, source_type, title, author_name, url, published_at,
            ts_headline('english', ${ARCHIVE_SEARCH_DOCUMENT_SQL}, plainto_tsquery('english', `,
    `), '${snippetOptions}') AS snippet
       FROM feed_items
      WHERE ${ARCHIVE_SEARCH_VECTOR_SQL} @@ plainto_tsquery('english', `,
    `)
        AND (`,
    ` = 'all' OR source_type = `,
    `)
        AND (`,
    `::date IS NULL OR published_at >= `,
    `::date)
        AND (`,
    `::date IS NULL OR published_at < (`,
    `::date + interval '1 day'))
      ORDER BY published_at DESC
      LIMIT `,
    ``,
  ];
  const template = [...strings] as unknown as TemplateStringsArray;
  Object.defineProperty(template, "raw", { value: [...strings] });
  return template;
}

function mapResearchResults(rows: ArchiveSearchRow[]): SearchResult[] {
  return rows.map((row) => ({ ...row }));
}

function mapToolResults(rows: ArchiveSearchRow[]): ArchiveSearchToolResult[] {
  return rows.map((row) => ({
    ...row,
    snippet: row.snippet
      .replaceAll(TOOL_SNIPPET_START, "")
      .replaceAll(TOOL_SNIPPET_END, ""),
  }));
}

function normalizeTotalCount(value: number | string | undefined): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(value ?? "0", 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function truncateArchiveExcerpt(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 360);
}

async function queryArchiveSearchRows(
  params: ArchiveSearchParams,
  snippetOptions: string,
): Promise<ArchiveSearchRow[]> {
  const template = buildArchiveSearchTemplate(snippetOptions);

  return sql(
    template,
    params.query,
    params.query,
    params.source,
    params.source,
    params.after,
    params.after,
    params.before,
    params.before,
    params.limit,
  ) as Promise<ArchiveSearchRow[]>;
}

export async function searchArchiveForResearch(
  params: ArchiveSearchParams,
): Promise<SearchResult[]> {
  const rows = await queryArchiveSearchRows(params, RESEARCH_SNIPPET_OPTIONS);
  return mapResearchResults(rows);
}

export async function searchArchiveForTool(
  params: ArchiveSearchParams,
): Promise<ArchiveSearchToolResult[]> {
  const rows = await queryArchiveSearchRows(params, TOOL_SNIPPET_OPTIONS);
  return mapToolResults(rows);
}

export async function listArchiveItemsForTool(
  params: ArchiveListParams,
): Promise<ArchiveListForToolResult> {
  const rows = (await sql`
    SELECT
      id,
      source_type,
      title,
      author_name,
      author_handle,
      url,
      published_at,
      content,
      COUNT(*) OVER() AS total_count
    FROM feed_items
    WHERE (${params.source} = 'all' OR source_type = ${params.source})
      AND (
        ${params.author}::text IS NULL
        OR LOWER(COALESCE(author_name, '') || ' ' || COALESCE(author_handle, ''))
           LIKE '%' || LOWER(${params.author}) || '%'
      )
      AND (${params.after}::date IS NULL OR published_at >= ${params.after}::date)
      AND (${params.before}::date IS NULL OR published_at < (${params.before}::date + interval '1 day'))
    ORDER BY published_at DESC NULLS LAST, id DESC
    LIMIT ${params.limit}
    OFFSET ${params.offset}
  `) as ArchiveListRow[];

  const totalCount = normalizeTotalCount(rows[0]?.total_count);
  const results = rows.map((row) => ({
    id: row.id,
    source_type: row.source_type,
    title: row.title,
    author_name: row.author_name,
    author_handle: row.author_handle,
    url: row.url,
    published_at: row.published_at,
    content_excerpt: truncateArchiveExcerpt(row.content),
  }));

  return {
    results,
    total_count: totalCount,
    returned_count: results.length,
    offset: params.offset,
    has_more: params.offset + results.length < totalCount,
  };
}
