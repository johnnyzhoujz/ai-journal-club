import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  sql: vi.fn(),
}));

import { sql } from "@/lib/db";
import {
  ARCHIVE_SEARCH_DOCUMENT_SQL,
  ARCHIVE_SEARCH_VECTOR_SQL,
  listArchiveItemsForTool,
  searchArchiveForResearch,
  searchArchiveForTool,
} from "../archive-search";

const mockSql = sql as unknown as ReturnType<typeof vi.fn>;

function getInterpolatedValues(): unknown[] {
  return mockSql.mock.calls[0].slice(1);
}

function getSqlTemplate(): string {
  return mockSql.mock.calls[0][0].join("$");
}

describe("archive search helper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("preserves the Research UI result shape with HTML snippets", async () => {
    const rows = [
      {
        id: 1,
        source_type: "tweet",
        title: null,
        author_name: "karpathy",
        url: "https://x.com/karpathy/status/123",
        published_at: "2026-03-20T12:00:00Z",
        snippet: "building <b>agents</b> with LLMs",
      },
    ];
    mockSql.mockResolvedValueOnce(rows);

    const results = await searchArchiveForResearch({
      query: "agents",
      source: "all",
      after: null,
      before: null,
      limit: 20,
    });

    expect(results).toEqual(rows);
    expect(results[0]).toHaveProperty("snippet", "building <b>agents</b> with LLMs");
  });

  it("uses the shared combined search expression for title, author, and content", async () => {
    mockSql.mockResolvedValueOnce([]);

    await searchArchiveForResearch({
      query: "agents",
      source: "all",
      after: null,
      before: null,
      limit: 20,
    });

    const template = getSqlTemplate();
    expect(template).toContain(ARCHIVE_SEARCH_VECTOR_SQL);
    expect(template).toContain(ARCHIVE_SEARCH_DOCUMENT_SQL);
    expect(template).toContain("COALESCE(author_name, '')");
    expect(template).toContain("plainto_tsquery('english'");
  });

  it("uses ts_headline for Research HTML snippet formatting", async () => {
    mockSql.mockResolvedValueOnce([]);

    await searchArchiveForResearch({
      query: "agents",
      source: "tweet",
      after: "2026-01-01",
      before: "2026-03-01",
      limit: 5,
    });

    const template = getSqlTemplate();
    const values = getInterpolatedValues();

    expect(template).toContain("ts_headline");
    expect(template).toContain("StartSel=<b>, StopSel=</b>");
    expect(template).not.toContain("__archive_snippet_start__");
    expect(values).toEqual([
      "agents",
      "agents",
      "tweet",
      "tweet",
      "2026-01-01",
      "2026-01-01",
      "2026-03-01",
      "2026-03-01",
      5,
    ]);
  });

  it("returns plain-text tool snippets without leaking HTML highlights", async () => {
    mockSql.mockResolvedValueOnce([
      {
        id: 1,
        source_type: "paper",
        title: "Multi-Agent Systems",
        author_name: "Jane Doe",
        url: "https://arxiv.org/abs/2603.12345",
        published_at: "2026-03-19T08:00:00Z",
        snippet:
          "research __archive_snippet_start__agents__archive_snippet_end__ in context",
      },
    ]);

    const results = await searchArchiveForTool({
      query: "agents",
      source: "paper",
      after: null,
      before: null,
      limit: 8,
    });

    expect(results).toEqual([
      {
        id: 1,
        source_type: "paper",
        title: "Multi-Agent Systems",
        author_name: "Jane Doe",
        url: "https://arxiv.org/abs/2603.12345",
        published_at: "2026-03-19T08:00:00Z",
        snippet: "research agents in context",
      },
    ]);
  });

  it("uses a separate non-HTML snippet mode for tool searches", async () => {
    mockSql.mockResolvedValueOnce([]);

    await searchArchiveForTool({
      query: "agents",
      source: "all",
      after: null,
      before: null,
      limit: 8,
    });

    const template = getSqlTemplate();
    expect(template).toContain("StartSel=__archive_snippet_start__");
    expect(template).toContain("StopSel=__archive_snippet_end__");
    expect(template).not.toContain("StartSel=<b>, StopSel=</b>");
  });

  it("lists archive items with structured filters and total count metadata", async () => {
    mockSql.mockResolvedValueOnce([
      {
        id: 42,
        source_type: "tweet",
        title: null,
        author_name: "Aaron Levie",
        author_handle: "levie",
        url: "https://x.com/levie/status/42",
        published_at: "2026-04-12T12:00:00Z",
        content: "A tweet about agents using enterprise software.",
        total_count: "21",
      },
    ]);

    const result = await listArchiveItemsForTool({
      source: "tweet",
      author: "Aaron Levie",
      after: "2026-04-01",
      before: "2026-04-30",
      limit: 20,
      offset: 0,
    });

    expect(result).toEqual({
      results: [
        {
          id: 42,
          source_type: "tweet",
          title: null,
          author_name: "Aaron Levie",
          author_handle: "levie",
          url: "https://x.com/levie/status/42",
          published_at: "2026-04-12T12:00:00Z",
          content_excerpt: "A tweet about agents using enterprise software.",
        },
      ],
      total_count: 21,
      returned_count: 1,
      offset: 0,
      has_more: true,
    });

    const template = getSqlTemplate();
    const values = getInterpolatedValues();
    expect(template).toContain("COUNT(*) OVER() AS total_count");
    expect(template).toContain("author_handle");
    expect(values).toEqual([
      "tweet",
      "tweet",
      "Aaron Levie",
      "Aaron Levie",
      "2026-04-01",
      "2026-04-01",
      "2026-04-30",
      "2026-04-30",
      20,
      0,
    ]);
  });
});
