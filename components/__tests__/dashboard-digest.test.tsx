// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Digest } from "@/lib/schema";

// Mock next/navigation
const mockRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

// Mock server actions
vi.mock("@/app/actions", () => ({
  generateDigestAction: vi.fn(),
}));

import { DashboardDigest } from "../dashboard-digest";
import { generateDigestAction } from "@/app/actions";

const mockGenerateDigestAction = generateDigestAction as unknown as ReturnType<typeof vi.fn>;

const DIGEST: Digest = {
  id: 1,
  content: `# AI Journal Club Digest — March 21, 2026\n\n## 🐦 X / Twitter\n\n**Garry Tan** (garrytan on X) shared insights. [Source →](https://x.com/garrytan/status/001)\n\n---\n\n## 🎙️ Podcasts\n\n**Lex Fridman** hosted Dario Amodei. [Source →](https://youtube.com/watch?v=abc)`,
  item_count: 7,
  tweet_count: 3,
  podcast_count: 1,
  newsletter_count: 2,
  paper_count: 1,
  source_item_ids: [],
  model: "claude-haiku-4-5-20251001",
  generated_at: "2026-03-21T10:00:00Z",
};

describe("DashboardDigest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders formatted date", () => {
    render(<DashboardDigest digest={DIGEST} />);
    expect(screen.getByText(/Generated March 21, 2026/)).toBeInTheDocument();
  });

  it("renders markdown headings as HTML elements, not raw text", () => {
    render(<DashboardDigest digest={DIGEST} />);
    const headings = screen.getAllByRole("heading", { level: 2 });
    const texts = headings.map((h) => h.textContent);
    expect(texts).toContain("🐦 X / Twitter");
  });

  it("renders bold text as <strong>", () => {
    const { container } = render(<DashboardDigest digest={DIGEST} />);
    const strongEls = container.querySelectorAll("strong");
    const texts = Array.from(strongEls).map((el) => el.textContent);
    expect(texts).toContain("Garry Tan");
  });

  it("renders markdown links as clickable <a> tags", () => {
    render(<DashboardDigest digest={DIGEST} />);
    const links = screen.getAllByRole("link", { name: /Source →/ });
    expect(links.length).toBeGreaterThanOrEqual(1);
    expect(links[0]).toHaveAttribute("href", "https://x.com/garrytan/status/001");
  });

  it("all links open in new tab with noopener noreferrer", () => {
    render(<DashboardDigest digest={DIGEST} />);
    const links = screen.getAllByRole("link");
    for (const link of links) {
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }
  });

  it("does not use <pre> or whitespace-pre-wrap", () => {
    const { container } = render(<DashboardDigest digest={DIGEST} />);
    expect(container.querySelector("pre")).toBeNull();
  });

  it("renders item stats", () => {
    render(<DashboardDigest digest={DIGEST} />);
    expect(screen.getByText(/7 items/)).toBeInTheDocument();
    expect(screen.getByText(/3 tweets/)).toBeInTheDocument();
    expect(screen.getByText(/1 podcast/)).toBeInTheDocument();
  });

  it("does not render raw HTML from content", () => {
    const xssDigest: Digest = {
      ...DIGEST,
      content: '<script>alert("xss")</script>\n\n**safe bold**',
    };
    const { container } = render(<DashboardDigest digest={xssDigest} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("strong")).toBeInTheDocument();
  });

  // -- Regenerate button --------------------------------------------------------

  it("renders Regenerate button", () => {
    render(<DashboardDigest digest={DIGEST} />);
    expect(
      screen.getByRole("button", { name: /regenerate/i }),
    ).toBeInTheDocument();
  });

  it("shows loading state when Regenerate is clicked", async () => {
    const user = userEvent.setup();
    mockGenerateDigestAction.mockReturnValueOnce(new Promise(() => {})); // never resolves

    render(<DashboardDigest digest={DIGEST} />);
    await user.click(screen.getByRole("button", { name: /regenerate/i }));

    expect(
      screen.getByRole("button", { name: /regenerating/i }),
    ).toBeDisabled();
  });

  it("calls generateDigestAction with force=true on Regenerate", async () => {
    const user = userEvent.setup();
    mockGenerateDigestAction.mockResolvedValueOnce({
      content: "New digest",
      item_count: 5,
    });

    render(<DashboardDigest digest={DIGEST} />);
    await user.click(screen.getByRole("button", { name: /regenerate/i }));

    await waitFor(() => {
      expect(mockGenerateDigestAction).toHaveBeenCalledWith(true);
    });
  });

  it("calls router.refresh() after successful regeneration", async () => {
    const user = userEvent.setup();
    mockGenerateDigestAction.mockResolvedValueOnce({
      content: "New digest",
      item_count: 5,
    });

    render(<DashboardDigest digest={DIGEST} />);
    await user.click(screen.getByRole("button", { name: /regenerate/i }));

    await waitFor(() => {
      expect(mockRefresh).toHaveBeenCalled();
    });
  });
});
