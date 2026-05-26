// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SearchResult } from "@/lib/schema";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import ResearchPage from "../page";

const MOCK_RESULTS: SearchResult[] = [
  {
    id: 1,
    source_type: "tweet",
    title: null,
    author_name: "karpathy",
    url: "https://x.com/karpathy/status/123",
    published_at: "2026-03-20T12:00:00Z",
    snippet: "building <b>agents</b> with LLMs",
  },
  {
    id: 2,
    source_type: "paper",
    title: "Multi-Agent Systems",
    author_name: "Jane Doe",
    url: "https://arxiv.org/abs/2603.12345",
    published_at: "2026-03-19T08:00:00Z",
    snippet: "research on <b>agents</b>",
  },
  {
    id: 3,
    source_type: "podcast",
    title: "AI Talk",
    author_name: "Lex Fridman",
    url: "https://youtube.com/watch?v=abc",
    published_at: "2026-03-18T10:00:00Z",
    snippet: "talking about <b>agents</b>",
  },
];

function mockSearchResponse(results: SearchResult[] = MOCK_RESULTS) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => results,
  });
}

function mockSearchError(status = 500) {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    json: async () => ({ error: "Search query failed" }),
  });
}

describe("ResearchPage", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  // -- Rendering tests (form elements) ----------------------------------------

  it("renders Research heading", () => {
    render(<ResearchPage />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Research");
  });

  it("renders search input", () => {
    render(<ResearchPage />);
    expect(screen.getByPlaceholderText(/search/i)).toBeInTheDocument();
  });

  it("renders search/submit button", () => {
    render(<ResearchPage />);
    expect(screen.getByRole("button", { name: /search/i })).toBeInTheDocument();
  });

  it("renders source type filter with all options", () => {
    render(<ResearchPage />);
    const select = screen.getByRole("combobox");
    const options = select.querySelectorAll("option");
    expect(options).toHaveLength(5);
    const values = Array.from(options).map((o) => o.value);
    expect(values).toContain("all");
    expect(values).toContain("tweet");
    expect(values).toContain("podcast");
    expect(values).toContain("newsletter");
    expect(values).toContain("paper");
  });

  it("renders after date input", () => {
    render(<ResearchPage />);
    expect(screen.getByLabelText(/after/i)).toBeInTheDocument();
  });

  it("renders before date input", () => {
    render(<ResearchPage />);
    expect(screen.getByLabelText(/before/i)).toBeInTheDocument();
  });

  it("source filter defaults to all", () => {
    render(<ResearchPage />);
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("all");
  });

  // -- Happy path — search flow -----------------------------------------------

  it("submits search and displays results", async () => {
    const user = userEvent.setup();
    render(<ResearchPage />);
    mockSearchResponse();

    await user.type(screen.getByPlaceholderText(/search/i), "agents");
    await user.click(screen.getByRole("button", { name: /search/i }));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    const fetchUrl = mockFetch.mock.calls[0][0] as string;
    expect(fetchUrl).toContain("/api/search");
    expect(fetchUrl).toContain("q=agents");

    await waitFor(() => {
      expect(screen.getByText("karpathy")).toBeInTheDocument();
    });
  });

  it("encodes query parameter in URL", async () => {
    const user = userEvent.setup();
    render(<ResearchPage />);
    mockSearchResponse();

    await user.type(screen.getByPlaceholderText(/search/i), "AI agents & LLMs");
    await user.click(screen.getByRole("button", { name: /search/i }));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    const fetchUrl = mockFetch.mock.calls[0][0] as string;
    expect(fetchUrl).toContain("q=AI+agents+%26+LLMs");
  });

  it("displays multiple results from search", async () => {
    const user = userEvent.setup();
    render(<ResearchPage />);
    mockSearchResponse();

    await user.type(screen.getByPlaceholderText(/search/i), "agents");
    await user.click(screen.getByRole("button", { name: /search/i }));

    await waitFor(() => {
      expect(screen.getByText("karpathy")).toBeInTheDocument();
      expect(screen.getByText("Jane Doe")).toBeInTheDocument();
      expect(screen.getByText("Lex Fridman")).toBeInTheDocument();
    });
  });

  // -- Filter tests -----------------------------------------------------------

  it("includes source filter in search URL", async () => {
    const user = userEvent.setup();
    render(<ResearchPage />);
    mockSearchResponse();

    await user.type(screen.getByPlaceholderText(/search/i), "agents");
    await user.selectOptions(screen.getByRole("combobox"), "tweet");
    await user.click(screen.getByRole("button", { name: /search/i }));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    const fetchUrl = mockFetch.mock.calls[0][0] as string;
    expect(fetchUrl).toContain("source=tweet");
  });

  it("includes after date in search URL", async () => {
    const user = userEvent.setup();
    render(<ResearchPage />);
    mockSearchResponse();

    await user.type(screen.getByPlaceholderText(/search/i), "agents");
    // Type date into the after input
    const afterInput = screen.getByLabelText(/after/i);
    await user.clear(afterInput);
    await user.type(afterInput, "2026-01-01");
    await user.click(screen.getByRole("button", { name: /search/i }));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    const fetchUrl = mockFetch.mock.calls[0][0] as string;
    expect(fetchUrl).toContain("after=2026-01-01");
  });

  it("includes before date in search URL", async () => {
    const user = userEvent.setup();
    render(<ResearchPage />);
    mockSearchResponse();

    await user.type(screen.getByPlaceholderText(/search/i), "agents");
    const beforeInput = screen.getByLabelText(/before/i);
    await user.clear(beforeInput);
    await user.type(beforeInput, "2026-03-01");
    await user.click(screen.getByRole("button", { name: /search/i }));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    const fetchUrl = mockFetch.mock.calls[0][0] as string;
    expect(fetchUrl).toContain("before=2026-03-01");
  });

  it("includes all filters in search URL", async () => {
    const user = userEvent.setup();
    render(<ResearchPage />);
    mockSearchResponse();

    await user.type(screen.getByPlaceholderText(/search/i), "agents");
    await user.selectOptions(screen.getByRole("combobox"), "paper");
    await user.type(screen.getByLabelText(/after/i), "2026-01-01");
    await user.type(screen.getByLabelText(/before/i), "2026-03-01");
    await user.click(screen.getByRole("button", { name: /search/i }));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    const fetchUrl = mockFetch.mock.calls[0][0] as string;
    expect(fetchUrl).toContain("q=agents");
    expect(fetchUrl).toContain("source=paper");
    expect(fetchUrl).toContain("after=2026-01-01");
    expect(fetchUrl).toContain("before=2026-03-01");
  });

  it("omits empty filter params from URL", async () => {
    const user = userEvent.setup();
    render(<ResearchPage />);
    mockSearchResponse();

    await user.type(screen.getByPlaceholderText(/search/i), "agents");
    await user.click(screen.getByRole("button", { name: /search/i }));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    const fetchUrl = mockFetch.mock.calls[0][0] as string;
    expect(fetchUrl).not.toContain("after=");
    expect(fetchUrl).not.toContain("before=");
  });

  it("resets source filter back to all", async () => {
    const user = userEvent.setup();
    render(<ResearchPage />);
    mockSearchResponse();

    await user.selectOptions(screen.getByRole("combobox"), "tweet");
    await user.selectOptions(screen.getByRole("combobox"), "all");
    await user.type(screen.getByPlaceholderText(/search/i), "agents");
    await user.click(screen.getByRole("button", { name: /search/i }));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    const fetchUrl = mockFetch.mock.calls[0][0] as string;
    // source=all should be present or source param should not restrict
    expect(fetchUrl).toContain("source=all");
  });

  // -- Validation / guard tests -----------------------------------------------

  it("does not fetch when query is empty", async () => {
    const user = userEvent.setup();
    render(<ResearchPage />);

    await user.click(screen.getByRole("button", { name: /search/i }));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("does not fetch when query is only whitespace", async () => {
    const user = userEvent.setup();
    render(<ResearchPage />);

    await user.type(screen.getByPlaceholderText(/search/i), "   ");
    await user.click(screen.getByRole("button", { name: /search/i }));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("search button is disabled when query is empty", () => {
    render(<ResearchPage />);
    expect(screen.getByRole("button", { name: /search/i })).toBeDisabled();
  });

  it("search button is enabled when query has text", async () => {
    const user = userEvent.setup();
    render(<ResearchPage />);

    await user.type(screen.getByPlaceholderText(/search/i), "test");
    expect(screen.getByRole("button", { name: /search/i })).toBeEnabled();
  });

  // -- Loading state tests ----------------------------------------------------

  it("shows loading state while searching", async () => {
    const user = userEvent.setup();
    render(<ResearchPage />);

    // Never-resolving promise to keep loading state
    mockFetch.mockReturnValueOnce(new Promise(() => {}));

    await user.type(screen.getByPlaceholderText(/search/i), "agents");
    await user.click(screen.getByRole("button", { name: /search/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /searching/i })).toBeInTheDocument();
    });
  });

  it("disables search button while loading", async () => {
    const user = userEvent.setup();
    render(<ResearchPage />);

    mockFetch.mockReturnValueOnce(new Promise(() => {}));

    await user.type(screen.getByPlaceholderText(/search/i), "agents");
    await user.click(screen.getByRole("button", { name: /search/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /search/i })).toBeDisabled();
    });
  });

  it("loading clears after successful response", async () => {
    const user = userEvent.setup();
    render(<ResearchPage />);
    mockSearchResponse();

    await user.type(screen.getByPlaceholderText(/search/i), "agents");
    await user.click(screen.getByRole("button", { name: /search/i }));

    await waitFor(() => {
      expect(screen.getByText("karpathy")).toBeInTheDocument();
    });

    // Button should show "Search" again, not "Searching..."
    expect(screen.getByRole("button", { name: /^search$/i })).toBeEnabled();
  });

  it("loading clears after error response", async () => {
    const user = userEvent.setup();
    render(<ResearchPage />);

    mockFetch.mockRejectedValueOnce(new TypeError("Network error"));

    await user.type(screen.getByPlaceholderText(/search/i), "agents");
    await user.click(screen.getByRole("button", { name: /search/i }));

    await waitFor(() => {
      expect(screen.queryByText(/searching/i)).not.toBeInTheDocument();
    });
  });

  // -- Error handling tests ---------------------------------------------------

  it("shows error message on network failure", async () => {
    const user = userEvent.setup();
    render(<ResearchPage />);

    mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    await user.type(screen.getByPlaceholderText(/search/i), "agents");
    await user.click(screen.getByRole("button", { name: /search/i }));

    await waitFor(() => {
      expect(screen.getByText(/failed|error/i)).toBeInTheDocument();
    });
  });

  it("shows error message on non-OK response", async () => {
    const user = userEvent.setup();
    render(<ResearchPage />);
    mockSearchError(500);

    await user.type(screen.getByPlaceholderText(/search/i), "agents");
    await user.click(screen.getByRole("button", { name: /search/i }));

    await waitFor(() => {
      expect(screen.getByText(/failed|error/i)).toBeInTheDocument();
    });
  });

  it("clears error on next successful search", async () => {
    const user = userEvent.setup();
    render(<ResearchPage />);

    // First search fails
    mockFetch.mockRejectedValueOnce(new TypeError("Network error"));
    await user.type(screen.getByPlaceholderText(/search/i), "agents");
    await user.click(screen.getByRole("button", { name: /search/i }));

    await waitFor(() => {
      expect(screen.getByText(/failed|error/i)).toBeInTheDocument();
    });

    // Second search succeeds
    mockSearchResponse();
    await user.click(screen.getByRole("button", { name: /search/i }));

    await waitFor(() => {
      expect(screen.getByText("karpathy")).toBeInTheDocument();
    });

    expect(screen.queryByText(/failed|error/i)).not.toBeInTheDocument();
  });

  it("clears previous results on new search", async () => {
    const user = userEvent.setup();
    render(<ResearchPage />);

    // First search
    mockSearchResponse();
    await user.type(screen.getByPlaceholderText(/search/i), "agents");
    await user.click(screen.getByRole("button", { name: /search/i }));

    await waitFor(() => {
      expect(screen.getByText("karpathy")).toBeInTheDocument();
    });

    // Second search with different results
    mockSearchResponse([{
      id: 99,
      source_type: "newsletter",
      title: "New Result",
      author_name: "New Author",
      url: "https://example.com",
      published_at: "2026-03-21T00:00:00Z",
      snippet: "new content",
    }]);
    await user.click(screen.getByRole("button", { name: /search/i }));

    await waitFor(() => {
      expect(screen.getByText("New Author")).toBeInTheDocument();
    });

    // Old results should be gone
    expect(screen.queryByText("karpathy")).not.toBeInTheDocument();
  });

  // -- Synthesize button tests ------------------------------------------------

  it("synthesize button not visible when no results", () => {
    render(<ResearchPage />);
    expect(screen.queryByRole("button", { name: /synthesize/i })).not.toBeInTheDocument();
  });

  it("synthesize button appears after results are loaded", async () => {
    const user = userEvent.setup();
    render(<ResearchPage />);
    mockSearchResponse();

    await user.type(screen.getByPlaceholderText(/search/i), "agents");
    await user.click(screen.getByRole("button", { name: /search/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /synthesize/i })).toBeInTheDocument();
    });
  });

  it("clicking synthesize calls POST /api/synthesize", async () => {
    const user = userEvent.setup();
    render(<ResearchPage />);
    mockSearchResponse();

    await user.type(screen.getByPlaceholderText(/search/i), "agents");
    await user.click(screen.getByRole("button", { name: /search/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /synthesize/i })).toBeInTheDocument();
    });

    // Mock the synthesize response
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ synthesis: "Here is a synthesis of the results..." }),
    });

    await user.click(screen.getByRole("button", { name: /synthesize/i }));

    await waitFor(() => {
      const synthCall = mockFetch.mock.calls[1]; // second fetch call
      expect(synthCall[0]).toContain("/api/synthesize");
      expect(synthCall[1].method).toBe("POST");
      const body = JSON.parse(synthCall[1].body);
      expect(body.query).toBe("agents");
      expect(body.results).toHaveLength(3);
    });
  });

  it("displays synthesis text after response", async () => {
    const user = userEvent.setup();
    render(<ResearchPage />);
    mockSearchResponse();

    await user.type(screen.getByPlaceholderText(/search/i), "agents");
    await user.click(screen.getByRole("button", { name: /search/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /synthesize/i })).toBeInTheDocument();
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ synthesis: "Synthesis: agents are programs that act autonomously." }),
    });

    await user.click(screen.getByRole("button", { name: /synthesize/i }));

    await waitFor(() => {
      expect(screen.getByText(/agents are programs that act autonomously/)).toBeInTheDocument();
    });
  });

  it("shows loading state while synthesizing", async () => {
    const user = userEvent.setup();
    render(<ResearchPage />);
    mockSearchResponse();

    await user.type(screen.getByPlaceholderText(/search/i), "agents");
    await user.click(screen.getByRole("button", { name: /search/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /synthesize/i })).toBeInTheDocument();
    });

    mockFetch.mockReturnValueOnce(new Promise(() => {}));
    await user.click(screen.getByRole("button", { name: /synthesize/i }));

    await waitFor(() => {
      expect(screen.getByText(/synthesizing/i)).toBeInTheDocument();
    });
  });

  it("shows error if synthesize fails", async () => {
    const user = userEvent.setup();
    render(<ResearchPage />);
    mockSearchResponse();

    await user.type(screen.getByPlaceholderText(/search/i), "agents");
    await user.click(screen.getByRole("button", { name: /search/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /synthesize/i })).toBeInTheDocument();
    });

    mockFetch.mockRejectedValueOnce(new TypeError("Network error"));
    await user.click(screen.getByRole("button", { name: /synthesize/i }));

    await waitFor(() => {
      expect(screen.getByText(/failed|error/i)).toBeInTheDocument();
    });
  });
});
