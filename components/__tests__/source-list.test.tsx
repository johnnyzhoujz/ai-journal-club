// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Source } from "@/lib/schema";

import { SourceList } from "../source-list";

const X_SOURCE: Source = {
  id: 1, type: "x_account", name: "Elon Musk", handle: "elonmusk",
  podcast_type: null, channel_handle: null, playlist_id: null,
  url: null, feed_url: null, created_at: "2026-01-01T00:00:00Z", active: true,
};

const PODCAST_SOURCE: Source = {
  id: 2, type: "podcast", name: "Lex Fridman", handle: null,
  podcast_type: "youtube_channel", channel_handle: "lexfridman",
  playlist_id: null, url: "https://youtube.com/@lexfridman",
  feed_url: null, created_at: "2026-01-01T00:00:00Z", active: true,
};

const NEWSLETTER_SOURCE: Source = {
  id: 3, type: "newsletter", name: "AI Weekly", handle: null,
  podcast_type: null, channel_handle: null, playlist_id: null,
  url: "https://aiweekly.co", feed_url: "https://aiweekly.co/feed",
  created_at: "2026-01-01T00:00:00Z", active: true,
};

describe("SourceList", () => {
  const mockOnRemove = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockOnRemove.mockResolvedValue(true);
  });

  it("renders a list of sources with their names", () => {
    render(
      <SourceList sources={[X_SOURCE, { ...X_SOURCE, id: 5, name: "Karpathy", handle: "karpathy" }]} onRemove={mockOnRemove} type="x_account" />
    );

    expect(screen.getByText("Elon Musk")).toBeInTheDocument();
    expect(screen.getByText("Karpathy")).toBeInTheDocument();
  });

  it("renders empty state when no sources", () => {
    render(<SourceList sources={[]} onRemove={mockOnRemove} type="x_account" />);

    expect(screen.getByText(/no x accounts/i)).toBeInTheDocument();
  });

  it("renders empty state message for newsletters", () => {
    render(<SourceList sources={[]} onRemove={mockOnRemove} type="newsletter" />);

    expect(screen.getByText(/no newsletters/i)).toBeInTheDocument();
  });

  it("displays @handle for x_account sources", () => {
    render(<SourceList sources={[X_SOURCE]} onRemove={mockOnRemove} type="x_account" />);

    expect(screen.getByText("@elonmusk")).toBeInTheDocument();
  });

  it("displays feed_url for newsletter sources", () => {
    render(<SourceList sources={[NEWSLETTER_SOURCE]} onRemove={mockOnRemove} type="newsletter" />);

    expect(screen.getByText("https://aiweekly.co/feed")).toBeInTheDocument();
  });

  it("displays podcast type for podcast sources", () => {
    render(<SourceList sources={[PODCAST_SOURCE]} onRemove={mockOnRemove} type="podcast" />);

    expect(screen.getByText(/youtube channel/i)).toBeInTheDocument();
  });

  it("calls onRemove with correct id when remove button clicked", async () => {
    const user = userEvent.setup();
    render(<SourceList sources={[X_SOURCE]} onRemove={mockOnRemove} type="x_account" />);

    const removeButton = screen.getByRole("button", { name: /remove/i });
    await user.click(removeButton);

    expect(mockOnRemove).toHaveBeenCalledWith(1);
  });
});
