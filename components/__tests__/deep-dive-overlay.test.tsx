// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Digest } from "@/lib/schema";

import { DeepDiveOverlay } from "../deep-dive/deep-dive-overlay";

const SAMPLE_DIGEST: Digest = {
  id: 1,
  content: "# AI Builders Digest\n\nSample content about AI trends.",
  item_count: 5,
  tweet_count: 3,
  podcast_count: 1,
  newsletter_count: 1,
  paper_count: 0,
  source_item_ids: [],
  model: "claude-haiku-4-5-20251001",
  generated_at: "2026-03-21T08:00:00Z",
};

describe("DeepDiveOverlay", () => {
  afterEach(() => {
    // Clean up any portaled content
    document.body.style.overflow = "";
  });

  it("renders backdrop", () => {
    render(<DeepDiveOverlay digest={SAMPLE_DIGEST} onClose={vi.fn()} />);
    expect(document.querySelector("[data-testid='deep-dive-backdrop']")).toBeInTheDocument();
  });

  it("renders digest content in the left panel", () => {
    render(<DeepDiveOverlay digest={SAMPLE_DIGEST} onClose={vi.fn()} />);
    expect(screen.getByText("March 21, 2026")).toBeInTheDocument();
    expect(screen.getByText(/Sample content about AI trends/)).toBeInTheDocument();
  });

  it("renders chat input in the right panel", () => {
    render(<DeepDiveOverlay digest={SAMPLE_DIGEST} onClose={vi.fn()} />);
    expect(screen.getByPlaceholderText(/ask/i)).toBeInTheDocument();
  });

  it("shows welcome message in chat panel", () => {
    render(<DeepDiveOverlay digest={SAMPLE_DIGEST} onClose={vi.fn()} />);
    expect(screen.getByText(/ask.*about this digest/i)).toBeInTheDocument();
  });

  it("calls onClose when backdrop is clicked", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<DeepDiveOverlay digest={SAMPLE_DIGEST} onClose={onClose} />);

    const backdrop = document.querySelector("[data-testid='deep-dive-backdrop']")!;
    await user.click(backdrop);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when Escape key is pressed", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<DeepDiveOverlay digest={SAMPLE_DIGEST} onClose={onClose} />);

    await user.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("locks body scroll on mount", () => {
    render(<DeepDiveOverlay digest={SAMPLE_DIGEST} onClose={vi.fn()} />);
    expect(document.body.style.overflow).toBe("hidden");
  });

  it("has a close button", () => {
    render(<DeepDiveOverlay digest={SAMPLE_DIGEST} onClose={vi.fn()} />);
    const closeButton = screen.getByRole("button", { name: /close/i });
    expect(closeButton).toBeInTheDocument();
  });

  it("calls onClose when close button is clicked", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<DeepDiveOverlay digest={SAMPLE_DIGEST} onClose={onClose} />);

    const closeButton = screen.getByRole("button", { name: /close/i });
    await user.click(closeButton);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // -- Edge cases -----------------------------------------------------------

  it("restores body scroll on unmount", () => {
    document.body.style.overflow = "auto";

    const { unmount } = render(
      <DeepDiveOverlay digest={SAMPLE_DIGEST} onClose={vi.fn()} />,
    );
    expect(document.body.style.overflow).toBe("hidden");

    unmount();
    expect(document.body.style.overflow).toBe("auto");
  });

  it("does not call onClose when clicking inside the content panel", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<DeepDiveOverlay digest={SAMPLE_DIGEST} onClose={onClose} />);

    const textarea = screen.getByPlaceholderText(/ask/i);
    await user.click(textarea);

    expect(onClose).not.toHaveBeenCalled();
  });
});
