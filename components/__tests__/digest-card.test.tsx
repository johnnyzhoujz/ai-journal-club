// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Digest } from "@/lib/schema";

import { DigestCard } from "../digest-card";

const DIGEST_FULL: Digest = {
  id: 1,
  content: "AI Builders Digest\n\nTweets section\nPodcast section",
  item_count: 11,
  tweet_count: 5,
  podcast_count: 2,
  newsletter_count: 3,
  paper_count: 1,
  source_item_ids: [],
  model: "claude-haiku-4-5-20251001",
  generated_at: "2026-03-21T08:00:00Z",
};

const DIGEST_TWEETS_ONLY: Digest = {
  id: 2,
  content: "Only tweets today",
  item_count: 3,
  tweet_count: 3,
  podcast_count: 0,
  newsletter_count: 0,
  paper_count: 0,
  source_item_ids: [],
  model: "claude-haiku-4-5-20251001",
  generated_at: "2026-01-15T12:00:00Z",
};

const DIGEST_NULL_MODEL: Digest = {
  id: 3,
  content: "Digest content",
  item_count: 1,
  tweet_count: 1,
  podcast_count: 0,
  newsletter_count: 0,
  paper_count: 0,
  source_item_ids: [],
  model: null,
  generated_at: "2025-12-25T00:00:00Z",
};

const DIGEST_SINGULAR: Digest = {
  id: 4,
  content: "One of each",
  item_count: 4,
  tweet_count: 1,
  podcast_count: 1,
  newsletter_count: 1,
  paper_count: 1,
  source_item_ids: [],
  model: "claude-haiku-4-5-20251001",
  generated_at: "2026-06-01T00:00:00Z",
};

const DIGEST_MARKDOWN: Digest = {
  id: 10,
  content: `# AI Builders Digest — March 21, 2026\n\n## 🐦 X / Twitter\n\n**Andrej Karpathy** (karpathy on X) released a new explainer on transformer internals. [Source →](https://x.com/karpathy/status/001)\n\n---\n\n## 🎙️ Podcasts\n\n**Lex Fridman** hosted Dario Amodei. [Source →](https://youtube.com/watch?v=abc)`,
  item_count: 5,
  tweet_count: 1,
  podcast_count: 1,
  newsletter_count: 0,
  paper_count: 0,
  source_item_ids: [],
  model: "claude-haiku-4-5-20251001",
  generated_at: "2026-03-21T08:00:00Z",
};

describe("DigestCard", () => {
  // -- Happy path tests -------------------------------------------------------

  it("renders human-readable date from generated_at", () => {
    render(<DigestCard digest={DIGEST_FULL} />);
    expect(screen.getByText("March 21, 2026")).toBeInTheDocument();
  });

  it("renders non-zero source type counts", () => {
    render(<DigestCard digest={DIGEST_FULL} />);
    expect(screen.getByText(/5 tweets/)).toBeInTheDocument();
    expect(screen.getByText(/2 podcasts/)).toBeInTheDocument();
    expect(screen.getByText(/3 newsletters/)).toBeInTheDocument();
    expect(screen.getByText(/1 paper/)).toBeInTheDocument();
  });

  it("renders total item count", () => {
    render(<DigestCard digest={DIGEST_FULL} />);
    expect(screen.getByText(/11 items/)).toBeInTheDocument();
  });

  it("does not show content in collapsed state", () => {
    render(<DigestCard digest={DIGEST_FULL} />);
    expect(screen.queryByText("AI Builders Digest")).not.toBeInTheDocument();
  });

  it("expands to show full content on click", async () => {
    const user = userEvent.setup();
    render(<DigestCard digest={DIGEST_FULL} />);

    await user.click(screen.getByRole("button"));
    expect(screen.getByText(/AI Builders Digest/)).toBeInTheDocument();
  });

  it("collapses content on second click", async () => {
    const user = userEvent.setup();
    render(<DigestCard digest={DIGEST_FULL} />);

    const button = screen.getByRole("button");
    await user.click(button);
    expect(screen.getByText(/AI Builders Digest/)).toBeInTheDocument();

    await user.click(button);
    expect(screen.queryByText("AI Builders Digest")).not.toBeInTheDocument();
  });

  it("renders chevron icon", () => {
    const { container } = render(<DigestCard digest={DIGEST_FULL} />);
    const svg = container.querySelector("svg");
    expect(svg).toBeInTheDocument();
  });

  // -- Edge case tests --------------------------------------------------------

  it("omits source types with zero count", () => {
    render(<DigestCard digest={DIGEST_TWEETS_ONLY} />);
    expect(screen.getByText(/3 tweets/)).toBeInTheDocument();
    expect(screen.queryByText(/podcast/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/newsletter/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/paper/i)).not.toBeInTheDocument();
  });

  it("handles singular count label", () => {
    render(<DigestCard digest={DIGEST_SINGULAR} />);
    expect(screen.getByText(/1 tweet/)).toBeInTheDocument();
    expect(screen.getByText(/1 podcast/)).toBeInTheDocument();
    expect(screen.getByText(/1 newsletter/)).toBeInTheDocument();
    expect(screen.getByText(/1 paper/)).toBeInTheDocument();
    // Should NOT contain plurals for count=1
    expect(screen.queryByText(/1 tweets/)).not.toBeInTheDocument();
  });

  it("handles plural count labels", () => {
    render(<DigestCard digest={DIGEST_FULL} />);
    expect(screen.getByText(/5 tweets/)).toBeInTheDocument();
    expect(screen.getByText(/2 podcasts/)).toBeInTheDocument();
    expect(screen.getByText(/3 newsletters/)).toBeInTheDocument();
  });

  it("renders correctly when model is null", () => {
    render(<DigestCard digest={DIGEST_NULL_MODEL} />);
    expect(screen.getByText("December 25, 2025")).toBeInTheDocument();
    expect(screen.getByText(/1 tweet/)).toBeInTheDocument();
  });

  // -- Markdown rendering tests -----------------------------------------------

  it("renders markdown links as clickable <a> tags", async () => {
    const user = userEvent.setup();
    render(<DigestCard digest={DIGEST_MARKDOWN} />);

    await user.click(screen.getByRole("button"));

    const links = screen.getAllByRole("link", { name: /Source →/ });
    expect(links.length).toBeGreaterThanOrEqual(1);
    expect(links[0]).toHaveAttribute("href", "https://x.com/karpathy/status/001");
  });

  it("all links open in new tab", async () => {
    const user = userEvent.setup();
    render(<DigestCard digest={DIGEST_MARKDOWN} />);

    await user.click(screen.getByRole("button"));

    const links = screen.getAllByRole("link");
    for (const link of links) {
      expect(link).toHaveAttribute("target", "_blank");
    }
  });

  it("all links have rel noopener noreferrer", async () => {
    const user = userEvent.setup();
    render(<DigestCard digest={DIGEST_MARKDOWN} />);

    await user.click(screen.getByRole("button"));

    const links = screen.getAllByRole("link");
    for (const link of links) {
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }
  });

  it("renders section headings as <h2>", async () => {
    const user = userEvent.setup();
    render(<DigestCard digest={DIGEST_MARKDOWN} />);

    await user.click(screen.getByRole("button"));

    const headings = screen.getAllByRole("heading", { level: 2 });
    const headingTexts = headings.map((h) => h.textContent);
    expect(headingTexts).toContain("🐦 X / Twitter");
    expect(headingTexts).toContain("🎙️ Podcasts");
  });

  it("renders bold author names as <strong>", async () => {
    const user = userEvent.setup();
    const { container } = render(<DigestCard digest={DIGEST_MARKDOWN} />);

    await user.click(screen.getByRole("button"));

    const strongEls = container.querySelectorAll("strong");
    const strongTexts = Array.from(strongEls).map((el) => el.textContent);
    expect(strongTexts).toContain("Andrej Karpathy");
  });

  it("renders horizontal rules between sections", async () => {
    const user = userEvent.setup();
    const { container } = render(<DigestCard digest={DIGEST_MARKDOWN} />);

    await user.click(screen.getByRole("button"));

    const hrs = container.querySelectorAll("[data-testid='digest-content'] hr");
    expect(hrs.length).toBeGreaterThanOrEqual(1);
  });

  it("renders multiple sections with distinct headings", async () => {
    const user = userEvent.setup();
    render(<DigestCard digest={DIGEST_MARKDOWN} />);

    await user.click(screen.getByRole("button"));

    const headings = screen.getAllByRole("heading", { level: 2 });
    expect(headings.length).toBeGreaterThanOrEqual(2);
  });

  it("does not render raw HTML from content", async () => {
    const user = userEvent.setup();
    const xssDigest: Digest = {
      ...DIGEST_FULL,
      content: '<script>alert("xss")</script>\n\n**safe bold**',
    };
    render(<DigestCard digest={xssDigest} />);

    await user.click(screen.getByRole("button"));

    // ReactMarkdown strips HTML by default — no <script> tag in the DOM
    const contentEl = screen.getByTestId("digest-content");
    expect(contentEl.querySelector("script")).toBeNull();
    // But markdown bold should still render
    expect(contentEl.querySelector("strong")).toBeInTheDocument();
  });

  it("expanded content has markdown structure, not plain whitespace-pre-wrap", async () => {
    const user = userEvent.setup();
    const { container } = render(<DigestCard digest={DIGEST_MARKDOWN} />);

    await user.click(screen.getByRole("button"));

    const contentEl = container.querySelector("[data-testid='digest-content']");
    expect(contentEl).toBeInTheDocument();
    // Should NOT have whitespace-pre-wrap (markdown handles formatting now)
    expect(contentEl).not.toHaveClass("whitespace-pre-wrap");
  });

  // -- Interaction tests ------------------------------------------------------

  it("each card manages its own expand state independently", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <DigestCard digest={DIGEST_FULL} />
        <DigestCard digest={DIGEST_TWEETS_ONLY} />
      </div>
    );

    const buttons = screen.getAllByRole("button");
    await user.click(buttons[0]);

    // First card expanded
    expect(screen.getByText(/AI Builders Digest/)).toBeInTheDocument();
    // Second card still collapsed
    expect(screen.queryByText("Only tweets today")).not.toBeInTheDocument();
  });

});
