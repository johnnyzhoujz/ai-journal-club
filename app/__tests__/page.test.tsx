// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/lib/db", () => ({
  sql: vi.fn(),
}));

// Mock client components to avoid dealing with client/server boundary in tests
vi.mock("@/components/dashboard-actions", () => ({
  DashboardActions: () => (
    <div data-testid="dashboard-actions">DashboardActions</div>
  ),
}));

vi.mock("@/components/dashboard-digest", () => ({
  DashboardDigest: ({ digest }: { digest: { content: string; generated_at: string } }) => (
    <div data-testid="dashboard-digest">
      <span>{new Date(digest.generated_at).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}</span>
      <span>{digest.content}</span>
    </div>
  ),
}));

import Home from "../page";
import { sql } from "@/lib/db";

const mockSql = sql as unknown as ReturnType<typeof vi.fn>;
const requiredEnv = {
  DATABASE_URL: "postgres://example",
  DATABASE_URL_UNPOOLED: "postgres://example-unpooled",
  ANTHROPIC_API_KEY: "anthropic-key",
  OPENAI_API_KEY: "openai-key",
  CRON_SECRET: "cron-secret",
  AUTH_PASSWORD: "password",
  AUTH_SESSION_SECRET: "session-secret",
};

const sampleDigest = {
  id: 1,
  content: "AI Journal Club Digest\n\nKey highlights from today.",
  item_count: 7,
  tweet_count: 3,
  podcast_count: 1,
  newsletter_count: 2,
  paper_count: 1,
  source_item_ids: [],
  model: "claude-haiku-4-5-20251001",
  generated_at: "2026-03-21T10:00:00Z",
};

function setupMockQueries({
  digest = sampleDigest as typeof sampleDigest | null,
  activeSources = 5,
  fetchedToday = 12,
  totalArchive = 150,
}: {
  digest?: typeof sampleDigest | null;
  activeSources?: number;
  fetchedToday?: number;
  totalArchive?: number;
} = {}) {
  // The page runs 4 parallel queries via Promise.all
  // Query order: latestDigest, activeSourceCount, fetchedTodayCount, totalArchiveCount
  mockSql
    .mockResolvedValueOnce(digest ? [digest] : []) // latest digest
    .mockResolvedValueOnce([{ count: activeSources }]) // active sources
    .mockResolvedValueOnce([{ count: fetchedToday }]) // fetched today
    .mockResolvedValueOnce([{ count: totalArchive }]); // total archive
}

async function renderPage() {
  const Page = await Home();
  render(Page);
}

describe("Dashboard page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(process.env, requiredEnv);
  });

  // -- Stats cards: happy ----------------------------------------------------

  it('shows "Active Sources" with correct count', async () => {
    setupMockQueries({ activeSources: 5 });
    await renderPage();

    expect(screen.getByText("Active Sources")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
  });

  it('shows "Fetched Today" with correct count', async () => {
    setupMockQueries({ fetchedToday: 12 });
    await renderPage();

    expect(screen.getByText("Fetched Today")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
  });

  it('shows "Total Archive" with correct count', async () => {
    setupMockQueries({ totalArchive: 150 });
    await renderPage();

    expect(screen.getByText("Total Archive")).toBeInTheDocument();
    expect(screen.getByText("150")).toBeInTheDocument();
  });

  // -- Stats cards: edge -----------------------------------------------------

  it('shows "0" when all counts are zero', async () => {
    setupMockQueries({
      activeSources: 0,
      fetchedToday: 0,
      totalArchive: 0,
      digest: null,
    });
    await renderPage();

    const zeros = screen.getAllByText("0");
    expect(zeros.length).toBe(3);
  });

  it("handles large numbers", async () => {
    setupMockQueries({ totalArchive: 999999 });
    await renderPage();

    expect(screen.getByText("999999")).toBeInTheDocument();
  });

  it("handles count as string from DB (bigint)", async () => {
    mockSql
      .mockResolvedValueOnce([sampleDigest])
      .mockResolvedValueOnce([{ count: "5" }])
      .mockResolvedValueOnce([{ count: "12" }])
      .mockResolvedValueOnce([{ count: "150" }]);

    await renderPage();

    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("150")).toBeInTheDocument();
  });

  // -- Digest: happy ---------------------------------------------------------

  it("shows digest content text", async () => {
    setupMockQueries();
    await renderPage();

    expect(
      screen.getByText(/Key highlights from today/),
    ).toBeInTheDocument();
  });

  it("shows generated_at timestamp", async () => {
    setupMockQueries();
    await renderPage();

    // Should show a formatted date
    expect(screen.getByText(/march 21/i)).toBeInTheDocument();
  });

  it('shows "Latest Digest" section heading', async () => {
    setupMockQueries();
    await renderPage();

    expect(screen.getByText("Latest Digest")).toBeInTheDocument();
  });

  // -- Digest: edge ----------------------------------------------------------

  it('shows "No digest yet" when no digest exists', async () => {
    setupMockQueries({ digest: null });
    await renderPage();

    expect(screen.getByText(/no digest yet/i)).toBeInTheDocument();
  });

  it("prompts user to generate first digest in empty state", async () => {
    setupMockQueries({ digest: null });
    await renderPage();

    expect(screen.getByText(/generate.*first/i)).toBeInTheDocument();
  });

  it("renders special characters in digest content", async () => {
    setupMockQueries({
      digest: {
        ...sampleDigest,
        content: "Content with <html> & special \"chars\"",
      },
    });
    await renderPage();

    expect(
      screen.getByText(/Content with <html> & special "chars"/),
    ).toBeInTheDocument();
  });

  it("renders long content without truncation", async () => {
    const longContent = "A".repeat(5000);
    setupMockQueries({
      digest: { ...sampleDigest, content: longContent },
    });
    await renderPage();

    expect(screen.getByText(longContent)).toBeInTheDocument();
  });

  // -- Integration -----------------------------------------------------------

  it("renders DashboardActions component", async () => {
    setupMockQueries();
    await renderPage();

    expect(screen.getByTestId("dashboard-actions")).toBeInTheDocument();
  });

  it('renders page heading "Dashboard"', async () => {
    setupMockQueries();
    await renderPage();

    expect(
      screen.getByRole("heading", { name: /dashboard/i, level: 1 }),
    ).toBeInTheDocument();
  });

  // -- Error -----------------------------------------------------------------

  it("shows Initial Setup when DB query fails", async () => {
    mockSql.mockRejectedValueOnce(new Error("Connection refused"));

    await renderPage();

    expect(
      screen.getByRole("heading", { name: /initial setup/i, level: 1 }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/failed to load dashboard/i)).not.toBeInTheDocument();
  });

  it("shows Initial Setup when required runtime env is missing", async () => {
    delete process.env.DATABASE_URL;

    await renderPage();

    expect(
      screen.getByRole("heading", { name: /initial setup/i, level: 1 }),
    ).toBeInTheDocument();
    expect(mockSql).not.toHaveBeenCalled();
  });
});
