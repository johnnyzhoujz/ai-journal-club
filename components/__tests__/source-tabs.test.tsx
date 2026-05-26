// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { SourceTabs } from "../source-tabs";

const SOURCES_RESPONSE = {
  x_accounts: [
    { id: 1, type: "x_account", name: "Elon Musk", handle: "elonmusk", active: true, created_at: "2026-01-01T00:00:00Z" },
  ],
  podcasts: [
    { id: 2, type: "podcast", name: "Lex Fridman", podcast_type: "youtube_channel", url: "https://youtube.com/@lex", channel_handle: "lex", active: true, created_at: "2026-01-01T00:00:00Z" },
  ],
  newsletters: [],
  papers: { enabled: false, id: null },
};

function mockFetchResponse(data: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  });
}

describe("SourceTabs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReturnValue(mockFetchResponse(SOURCES_RESPONSE));
  });

  it("renders 4 tab buttons", async () => {
    render(<SourceTabs />);

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /x accounts/i })).toBeInTheDocument();
    });

    expect(screen.getByRole("tab", { name: /podcasts/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /newsletters/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /papers/i })).toBeInTheDocument();
  });

  it("X Accounts tab is active by default", async () => {
    render(<SourceTabs />);

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /x accounts/i })).toHaveAttribute("aria-selected", "true");
    });
  });

  it("clicking Podcasts tab shows podcast content", async () => {
    const user = userEvent.setup();
    render(<SourceTabs />);

    await waitFor(() => {
      expect(screen.getByText("Elon Musk")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("tab", { name: /podcasts/i }));

    expect(screen.getByText("Lex Fridman")).toBeInTheDocument();
    expect(screen.queryByText("Elon Musk")).not.toBeInTheDocument();
  });

  it("clicking Newsletters tab shows empty state", async () => {
    const user = userEvent.setup();
    render(<SourceTabs />);

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /newsletters/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("tab", { name: /newsletters/i }));

    expect(screen.getByText(/no newsletters/i)).toBeInTheDocument();
  });

  it("clicking Papers tab shows toggle instead of form+list", async () => {
    const user = userEvent.setup();
    render(<SourceTabs />);

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /papers/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("tab", { name: /papers/i }));

    expect(screen.getByRole("switch")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /add/i })).not.toBeInTheDocument();
  });

  it("fetches sources on mount and displays them", async () => {
    render(<SourceTabs />);

    await waitFor(() => {
      expect(screen.getByText("Elon Musk")).toBeInTheDocument();
    });

    expect(mockFetch).toHaveBeenCalledWith("/api/sources");
  });

  it("shows loading state while fetching", () => {
    mockFetch.mockReturnValue(new Promise(() => {})); // never resolves

    render(<SourceTabs />);

    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("shows error message on fetch failure with tabs still visible", async () => {
    mockFetch.mockReturnValueOnce(Promise.reject(new Error("Network")));

    render(<SourceTabs />);

    await waitFor(() => {
      expect(screen.getByText(/failed to load sources/i)).toBeInTheDocument();
    });

    // Tabs should still be visible even when there's an error
    expect(screen.getByRole("tab", { name: /x accounts/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /papers/i })).toBeInTheDocument();
  });
});
