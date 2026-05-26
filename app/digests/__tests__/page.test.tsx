// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Digest } from "@/lib/schema";

vi.mock("@/lib/db", () => ({
  sql: vi.fn(),
}));

import DigestsPage from "../page";
import { sql } from "@/lib/db";

const mockSql = sql as unknown as ReturnType<typeof vi.fn>;

const DIGEST_1: Digest = {
  id: 1,
  content: "Digest one content",
  item_count: 7,
  tweet_count: 3,
  podcast_count: 1,
  newsletter_count: 2,
  paper_count: 1,
  source_item_ids: [],
  model: "claude-haiku-4-5-20251001",
  generated_at: "2026-03-21T08:00:00Z",
};

const DIGEST_2: Digest = {
  id: 2,
  content: "Digest two content",
  item_count: 4,
  tweet_count: 2,
  podcast_count: 0,
  newsletter_count: 1,
  paper_count: 1,
  source_item_ids: [],
  model: "claude-haiku-4-5-20251001",
  generated_at: "2026-03-20T08:00:00Z",
};

const DIGEST_3: Digest = {
  id: 3,
  content: "Digest three content",
  item_count: 10,
  tweet_count: 5,
  podcast_count: 2,
  newsletter_count: 2,
  paper_count: 1,
  source_item_ids: [],
  model: "claude-haiku-4-5-20251001",
  generated_at: "2026-03-19T08:00:00Z",
};

describe("DigestsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -- Happy path tests -------------------------------------------------------

  it("renders Digests heading", async () => {
    mockSql.mockResolvedValueOnce([DIGEST_1]);
    const jsx = await DigestsPage();
    render(jsx);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Digests");
  });

  it("renders a card for each digest", async () => {
    mockSql.mockResolvedValueOnce([DIGEST_1, DIGEST_2, DIGEST_3]);
    const jsx = await DigestsPage();
    render(jsx);
    expect(screen.getByText("March 21, 2026")).toBeInTheDocument();
    expect(screen.getByText("March 20, 2026")).toBeInTheDocument();
    expect(screen.getByText("March 19, 2026")).toBeInTheDocument();
  });

  it("queries digests ordered by generated_at DESC", async () => {
    mockSql.mockResolvedValueOnce([]);
    await DigestsPage();
    expect(mockSql).toHaveBeenCalledTimes(1);
    const template = mockSql.mock.calls[0][0].join(" ");
    expect(template).toContain("ORDER BY generated_at DESC");
  });

  it("queries from the digests table", async () => {
    mockSql.mockResolvedValueOnce([]);
    await DigestsPage();
    const template = mockSql.mock.calls[0][0].join(" ");
    expect(template).toContain("SELECT");
    expect(template).toContain("FROM digests");
  });

  // -- Empty state tests ------------------------------------------------------

  it("renders empty state message when no digests", async () => {
    mockSql.mockResolvedValueOnce([]);
    const jsx = await DigestsPage();
    render(jsx);
    expect(screen.getByText(/no digests yet/i)).toBeInTheDocument();
  });

  it("does not render any cards in empty state", async () => {
    mockSql.mockResolvedValueOnce([]);
    const jsx = await DigestsPage();
    const { container } = render(jsx);
    // No digest card buttons should be present
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    // No SVG chevron icons should be present
    expect(container.querySelectorAll("svg")).toHaveLength(0);
  });

  // -- Data flow tests --------------------------------------------------------

  it("passes digest data to each card component", async () => {
    mockSql.mockResolvedValueOnce([DIGEST_1, DIGEST_2]);
    const jsx = await DigestsPage();
    render(jsx);
    // Both dates should be visible, confirming data is passed through
    expect(screen.getByText("March 21, 2026")).toBeInTheDocument();
    expect(screen.getByText("March 20, 2026")).toBeInTheDocument();
    // Both item counts should be visible
    expect(screen.getByText(/7 items/)).toBeInTheDocument();
    expect(screen.getByText(/4 items/)).toBeInTheDocument();
  });

  it("renders digests in order returned by query", async () => {
    mockSql.mockResolvedValueOnce([DIGEST_1, DIGEST_2]);
    const jsx = await DigestsPage();
    const { container } = render(jsx);
    const buttons = container.querySelectorAll("button");
    // First card should contain the more recent date
    expect(buttons[0].textContent).toContain("March 21, 2026");
    expect(buttons[1].textContent).toContain("March 20, 2026");
  });

  // -- Error handling tests ---------------------------------------------------

  it("shows error state when DB query fails", async () => {
    mockSql.mockRejectedValueOnce(new Error("Connection refused"));
    const jsx = await DigestsPage();
    render(jsx);
    expect(screen.getByText(/error|failed/i)).toBeInTheDocument();
  });

  it("still renders the page heading when DB query fails", async () => {
    mockSql.mockRejectedValueOnce(new Error("Connection refused"));
    const jsx = await DigestsPage();
    render(jsx);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Digests");
  });
});
