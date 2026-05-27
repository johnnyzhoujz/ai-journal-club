// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Mock next/navigation
const mockRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

// Mock server actions
vi.mock("@/app/actions", () => ({
  generateDigestAction: vi.fn(),
  runFetchAction: vi.fn(),
}));

import { DashboardActions } from "../dashboard-actions";
import { generateDigestAction, runFetchAction } from "@/app/actions";

const mockGenerateDigest = generateDigestAction as unknown as ReturnType<
  typeof vi.fn
>;
const mockRunFetch = runFetchAction as unknown as ReturnType<typeof vi.fn>;

describe("DashboardActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -- Render ----------------------------------------------------------------

  it('renders "Generate Digest" button', () => {
    render(<DashboardActions />);
    expect(
      screen.getByRole("button", { name: /generate digest/i }),
    ).toBeInTheDocument();
  });

  it('renders "Run Fetch Now" button', () => {
    render(<DashboardActions />);
    expect(
      screen.getByRole("button", { name: /run fetch now/i }),
    ).toBeInTheDocument();
  });

  it("shows no result message initially", () => {
    render(<DashboardActions />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  // -- Generate Digest: happy ------------------------------------------------

  it('shows "Generating..." and disables button while loading', async () => {
    const user = userEvent.setup();
    let resolve: (v: unknown) => void;
    mockGenerateDigest.mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );

    render(<DashboardActions />);
    await user.click(
      screen.getByRole("button", { name: /generate digest/i }),
    );

    expect(screen.getByText(/generating/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /generating/i }),
    ).toBeDisabled();

    resolve!({ content: "digest", item_count: 5 });
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /generate digest/i }),
      ).toBeEnabled();
    });
  });

  it("shows success message with item count", async () => {
    const user = userEvent.setup();
    mockGenerateDigest.mockResolvedValueOnce({
      content: "AI Digest",
      item_count: 7,
    });

    render(<DashboardActions />);
    await user.click(
      screen.getByRole("button", { name: /generate digest/i }),
    );

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toMatch(/7 items/i);
    });
  });

  it("calls router.refresh() on successful digest", async () => {
    const user = userEvent.setup();
    mockGenerateDigest.mockResolvedValueOnce({
      content: "digest",
      item_count: 3,
    });

    render(<DashboardActions />);
    await user.click(
      screen.getByRole("button", { name: /generate digest/i }),
    );

    await waitFor(() => {
      expect(mockRefresh).toHaveBeenCalled();
    });
  });

  // -- Generate Digest: edge -------------------------------------------------

  it('shows "No new content" message from API', async () => {
    const user = userEvent.setup();
    mockGenerateDigest.mockResolvedValueOnce({
      message: "No new content to digest",
    });

    render(<DashboardActions />);
    await user.click(
      screen.getByRole("button", { name: /generate digest/i }),
    );

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toMatch(
        /no new content/i,
      );
    });
  });

  it("shows paper processing progress when digest is still pending", async () => {
    const user = userEvent.setup();
    mockGenerateDigest.mockResolvedValueOnce({
      message: "28 papers are still being processed before a digest can be generated.",
      paperProcessing: {
        hydrate: { succeeded: 28, deadlineReached: false },
        enrich: { succeeded: 12, deadlineReached: true },
      },
    });

    render(<DashboardActions />);
    await user.click(
      screen.getByRole("button", { name: /generate digest/i }),
    );

    await waitFor(() => {
      const status = screen.getByRole("status").textContent!;
      expect(status).toMatch(/28 papers are still being processed/i);
      expect(status).toMatch(/hydrated 28/i);
      expect(status).toMatch(/enriched 12/i);
      expect(status).toMatch(/processing is still catching up/i);
    });
  });

  it("prevents duplicate calls while loading", async () => {
    const user = userEvent.setup();
    mockGenerateDigest.mockReturnValueOnce(new Promise(() => {})); // never resolves

    render(<DashboardActions />);
    const btn = screen.getByRole("button", { name: /generate digest/i });
    await user.click(btn);

    // Button is now disabled, can't click again
    expect(
      screen.getByRole("button", { name: /generating/i }),
    ).toBeDisabled();
    expect(mockGenerateDigest).toHaveBeenCalledTimes(1);
  });

  // -- Generate Digest: error ------------------------------------------------

  it("shows error when action returns error", async () => {
    const user = userEvent.setup();
    mockGenerateDigest.mockResolvedValueOnce({
      error: "CRON_SECRET not configured",
    });

    render(<DashboardActions />);
    await user.click(
      screen.getByRole("button", { name: /generate digest/i }),
    );

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toMatch(
        /CRON_SECRET not configured/i,
      );
    });
  });

  it("shows generic error when action throws", async () => {
    const user = userEvent.setup();
    mockGenerateDigest.mockRejectedValueOnce(new Error("unexpected"));

    render(<DashboardActions />);
    await user.click(
      screen.getByRole("button", { name: /generate digest/i }),
    );

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toMatch(/error|failed/i);
    });
  });

  it("re-enables button after error", async () => {
    const user = userEvent.setup();
    mockGenerateDigest.mockResolvedValueOnce({ error: "Something went wrong" });

    render(<DashboardActions />);
    await user.click(
      screen.getByRole("button", { name: /generate digest/i }),
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /generate digest/i }),
      ).toBeEnabled();
    });
  });

  // -- Run Fetch: happy ------------------------------------------------------

  it('shows "Fetching..." and disables button while loading', async () => {
    const user = userEvent.setup();
    let resolve: (v: unknown) => void;
    mockRunFetch.mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );

    render(<DashboardActions />);
    await user.click(screen.getByRole("button", { name: /run fetch now/i }));

    expect(screen.getByText(/fetching/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /fetching/i })).toBeDisabled();

    resolve!({ tweets: 5, podcasts: 3, newsletters: 2, papers: 1 });
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /run fetch now/i }),
      ).toBeEnabled();
    });
  });

  it("shows fetch summary with total and per-type counts", async () => {
    const user = userEvent.setup();
    mockRunFetch.mockResolvedValueOnce({
      tweets: 5,
      podcasts: 3,
      newsletters: 2,
      papers: 1,
    });

    render(<DashboardActions />);
    await user.click(screen.getByRole("button", { name: /run fetch now/i }));

    await waitFor(() => {
      const status = screen.getByRole("status").textContent!;
      expect(status).toMatch(/11 items/i);
      expect(status).toMatch(/5 tweets/i);
      expect(status).toMatch(/3 podcasts/i);
      expect(status).toMatch(/2 newsletters/i);
      expect(status).toMatch(/1 paper/i);
    });
  });

  it("shows paper processing summary after fetching papers", async () => {
    const user = userEvent.setup();
    mockRunFetch.mockResolvedValueOnce({
      tweets: 0,
      podcasts: 0,
      newsletters: 0,
      papers: 28,
      paperProcessing: {
        hydrate: { succeeded: 28, deadlineReached: false },
        enrich: { succeeded: 28, deadlineReached: false },
      },
    });

    render(<DashboardActions />);
    await user.click(screen.getByRole("button", { name: /run fetch now/i }));

    await waitFor(() => {
      const status = screen.getByRole("status").textContent!;
      expect(status).toMatch(/28 papers/i);
      expect(status).toMatch(/hydrated 28/i);
      expect(status).toMatch(/enriched 28/i);
    });
  });

  it("tells the user when paper processing is still catching up", async () => {
    const user = userEvent.setup();
    mockRunFetch.mockResolvedValueOnce({
      tweets: 0,
      podcasts: 0,
      newsletters: 0,
      papers: 28,
      paperProcessing: {
        hydrate: { succeeded: 28, deadlineReached: false },
        enrich: { succeeded: 12, deadlineReached: true },
      },
    });

    render(<DashboardActions />);
    await user.click(screen.getByRole("button", { name: /run fetch now/i }));

    await waitFor(() => {
      const status = screen.getByRole("status").textContent!;
      expect(status).toMatch(/processing is still catching up/i);
    });
  });

  // -- Run Fetch: edge -------------------------------------------------------

  it('shows "Fetched 0 items" when all counts are zero', async () => {
    const user = userEvent.setup();
    mockRunFetch.mockResolvedValueOnce({
      tweets: 0,
      podcasts: 0,
      newsletters: 0,
      papers: 0,
    });

    render(<DashboardActions />);
    await user.click(screen.getByRole("button", { name: /run fetch now/i }));

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toMatch(/0 items/i);
    });
  });

  it("shows paper processing summary even when no new items were fetched", async () => {
    const user = userEvent.setup();
    mockRunFetch.mockResolvedValueOnce({
      tweets: 0,
      podcasts: 0,
      newsletters: 0,
      papers: 0,
      paperProcessing: {
        hydrate: { succeeded: 12, deadlineReached: false },
        enrich: { succeeded: 12, deadlineReached: false },
      },
    });

    render(<DashboardActions />);
    await user.click(screen.getByRole("button", { name: /run fetch now/i }));

    await waitFor(() => {
      const status = screen.getByRole("status").textContent!;
      expect(status).toMatch(/fetched 0 items/i);
      expect(status).toMatch(/hydrated 12/i);
      expect(status).toMatch(/enriched 12/i);
    });
  });

  it("treats missing counts as 0", async () => {
    const user = userEvent.setup();
    mockRunFetch.mockResolvedValueOnce({ tweets: 2 });

    render(<DashboardActions />);
    await user.click(screen.getByRole("button", { name: /run fetch now/i }));

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toMatch(/2 items/i);
    });
  });

  // -- Run Fetch: error ------------------------------------------------------

  it("shows error when fetch action returns error", async () => {
    const user = userEvent.setup();
    mockRunFetch.mockResolvedValueOnce({ error: "Server error" });

    render(<DashboardActions />);
    await user.click(screen.getByRole("button", { name: /run fetch now/i }));

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toMatch(/server error/i);
    });
  });

  it("shows generic error when fetch action throws", async () => {
    const user = userEvent.setup();
    mockRunFetch.mockRejectedValueOnce(new Error("boom"));

    render(<DashboardActions />);
    await user.click(screen.getByRole("button", { name: /run fetch now/i }));

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toMatch(/error|failed/i);
    });
  });

  it("re-enables fetch button after error", async () => {
    const user = userEvent.setup();
    mockRunFetch.mockResolvedValueOnce({ error: "Server error" });

    render(<DashboardActions />);
    await user.click(screen.getByRole("button", { name: /run fetch now/i }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /run fetch now/i }),
      ).toBeEnabled();
    });
  });

  // -- Independence ----------------------------------------------------------

  it("clicking one button does not disable the other", async () => {
    const user = userEvent.setup();
    mockGenerateDigest.mockReturnValueOnce(new Promise(() => {})); // never resolves

    render(<DashboardActions />);
    await user.click(
      screen.getByRole("button", { name: /generate digest/i }),
    );

    // Fetch button should still be enabled
    expect(
      screen.getByRole("button", { name: /run fetch now/i }),
    ).toBeEnabled();
  });

  it("new action clears previous result message", async () => {
    const user = userEvent.setup();
    mockGenerateDigest.mockResolvedValueOnce({
      content: "digest",
      item_count: 5,
    });

    render(<DashboardActions />);

    // First action
    await user.click(
      screen.getByRole("button", { name: /generate digest/i }),
    );
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toMatch(/5 items/i);
    });

    // Start a new action - previous message should clear
    mockGenerateDigest.mockReturnValueOnce(new Promise(() => {}));
    await user.click(
      screen.getByRole("button", { name: /generate digest/i }),
    );

    // Previous result should be gone, showing loading state now
    expect(screen.queryByText(/5 items/i)).not.toBeInTheDocument();
  });
});
