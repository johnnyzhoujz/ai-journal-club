// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { SearchResult } from "@/lib/schema";

import { SearchResults } from "../search-results";

const TWEET_RESULT: SearchResult = {
  id: 1,
  source_type: "tweet",
  title: null,
  author_name: "karpathy",
  url: "https://x.com/karpathy/status/123",
  published_at: "2026-03-20T12:00:00Z",
  snippet: "building <b>agents</b> with LLMs",
};

const PAPER_RESULT: SearchResult = {
  id: 2,
  source_type: "paper",
  title: "Multi-Agent Systems",
  author_name: "Jane Doe",
  url: "https://arxiv.org/abs/2603.12345",
  published_at: "2026-03-19T08:00:00Z",
  snippet: "research on <b>agents</b> and <b>LLMs</b>",
};

const PODCAST_RESULT: SearchResult = {
  id: 3,
  source_type: "podcast",
  title: "AI Safety Deep Dive",
  author_name: "Lex Fridman",
  url: "https://youtube.com/watch?v=abc",
  published_at: "2026-03-18T10:00:00Z",
  snippet: "discussing <b>alignment</b> research",
};

const NEWSLETTER_RESULT: SearchResult = {
  id: 4,
  source_type: "newsletter",
  title: "AI Weekly #42",
  author_name: "AI Weekly",
  url: "https://aiweekly.co/42",
  published_at: "2026-03-17T09:00:00Z",
  snippet: "weekly roundup of <b>AI</b> news",
};

const NULL_FIELDS_RESULT: SearchResult = {
  id: 5,
  source_type: "tweet",
  title: null,
  author_name: "anon",
  url: "https://x.com/anon/status/456",
  published_at: null,
  snippet: "some content",
};

describe("SearchResults", () => {
  // -- Happy path tests -------------------------------------------------------

  it("renders all results", () => {
    render(<SearchResults results={[TWEET_RESULT, PAPER_RESULT, PODCAST_RESULT]} />);
    expect(screen.getByText("karpathy")).toBeInTheDocument();
    expect(screen.getByText("Jane Doe")).toBeInTheDocument();
    expect(screen.getByText("Lex Fridman")).toBeInTheDocument();
  });

  it("shows author name for each result", () => {
    render(<SearchResults results={[TWEET_RESULT, PAPER_RESULT]} />);
    expect(screen.getByText("karpathy")).toBeInTheDocument();
    expect(screen.getByText("Jane Doe")).toBeInTheDocument();
  });

  it("shows formatted date for each result", () => {
    render(<SearchResults results={[TWEET_RESULT]} />);
    expect(screen.getByText("March 20, 2026")).toBeInTheDocument();
  });

  it("shows title when present", () => {
    render(<SearchResults results={[PAPER_RESULT]} />);
    expect(screen.getByText("Multi-Agent Systems")).toBeInTheDocument();
  });

  it("renders snippet with HTML bold tags", () => {
    const { container } = render(<SearchResults results={[TWEET_RESULT]} />);
    const boldElements = container.querySelectorAll("b");
    expect(boldElements.length).toBeGreaterThan(0);
    expect(boldElements[0].textContent).toBe("agents");
  });

  it("links to original source URL", () => {
    render(<SearchResults results={[TWEET_RESULT]} />);
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "https://x.com/karpathy/status/123");
  });

  it("links open in new tab", () => {
    render(<SearchResults results={[TWEET_RESULT]} />);
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("links have noopener noreferrer", () => {
    render(<SearchResults results={[TWEET_RESULT]} />);
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  // -- Source type badge tests ------------------------------------------------

  it("shows tweet badge for tweet results", () => {
    render(<SearchResults results={[TWEET_RESULT]} />);
    expect(screen.getByText("tweet")).toBeInTheDocument();
  });

  it("shows podcast badge for podcast results", () => {
    render(<SearchResults results={[PODCAST_RESULT]} />);
    expect(screen.getByText("podcast")).toBeInTheDocument();
  });

  it("shows newsletter badge for newsletter results", () => {
    render(<SearchResults results={[NEWSLETTER_RESULT]} />);
    expect(screen.getByText("newsletter")).toBeInTheDocument();
  });

  it("shows paper badge for paper results", () => {
    render(<SearchResults results={[PAPER_RESULT]} />);
    expect(screen.getByText("paper")).toBeInTheDocument();
  });

  it("tweet badge has blue styling", () => {
    render(<SearchResults results={[TWEET_RESULT]} />);
    const badge = screen.getByText("tweet");
    expect(badge.className).toMatch(/blue/);
  });

  it("podcast badge has purple styling", () => {
    render(<SearchResults results={[PODCAST_RESULT]} />);
    const badge = screen.getByText("podcast");
    expect(badge.className).toMatch(/purple/);
  });

  it("newsletter badge has green styling", () => {
    render(<SearchResults results={[NEWSLETTER_RESULT]} />);
    const badge = screen.getByText("newsletter");
    expect(badge.className).toMatch(/green/);
  });

  it("paper badge has amber styling", () => {
    render(<SearchResults results={[PAPER_RESULT]} />);
    const badge = screen.getByText("paper");
    expect(badge.className).toMatch(/amber/);
  });

  // -- Edge case tests --------------------------------------------------------

  it("renders empty state when results array is empty", () => {
    render(<SearchResults results={[]} />);
    expect(screen.getByText(/no results found/i)).toBeInTheDocument();
  });

  it("handles null title gracefully", () => {
    render(<SearchResults results={[TWEET_RESULT]} />);
    // Should not crash, and author name should still be visible
    expect(screen.getByText("karpathy")).toBeInTheDocument();
  });

  it("handles null published_at gracefully", () => {
    render(<SearchResults results={[NULL_FIELDS_RESULT]} />);
    expect(screen.getByText("anon")).toBeInTheDocument();
    // Should show some fallback text instead of crashing
    expect(screen.queryByText("Invalid Date")).not.toBeInTheDocument();
  });

  it("renders multiple results with same source type", () => {
    const secondTweet: SearchResult = {
      ...TWEET_RESULT,
      id: 10,
      author_name: "elonmusk",
      url: "https://x.com/elonmusk/status/999",
    };
    render(<SearchResults results={[TWEET_RESULT, secondTweet]} />);
    expect(screen.getByText("karpathy")).toBeInTheDocument();
    expect(screen.getByText("elonmusk")).toBeInTheDocument();
  });

  it("renders mixed source types", () => {
    render(
      <SearchResults
        results={[TWEET_RESULT, PAPER_RESULT, PODCAST_RESULT, NEWSLETTER_RESULT]}
      />
    );
    expect(screen.getByText("tweet")).toBeInTheDocument();
    expect(screen.getByText("paper")).toBeInTheDocument();
    expect(screen.getByText("podcast")).toBeInTheDocument();
    expect(screen.getByText("newsletter")).toBeInTheDocument();
  });
});
