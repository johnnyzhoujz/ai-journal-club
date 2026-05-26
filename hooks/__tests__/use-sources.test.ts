// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { useSources } from "../use-sources";

const EMPTY_RESPONSE = {
  x_accounts: [],
  podcasts: [],
  newsletters: [],
  papers: { enabled: false, id: null },
};

const POPULATED_RESPONSE = {
  x_accounts: [
    { id: 1, type: "x_account", name: "Elon", handle: "elonmusk", active: true, created_at: "2026-01-01T00:00:00Z" },
  ],
  podcasts: [
    { id: 2, type: "podcast", name: "Lex Pod", podcast_type: "youtube_channel", url: "https://youtube.com/@lex", channel_handle: "lex", active: true, created_at: "2026-01-01T00:00:00Z" },
  ],
  newsletters: [
    { id: 3, type: "newsletter", name: "AI Weekly", feed_url: "https://ai.com/feed", active: true, created_at: "2026-01-01T00:00:00Z" },
  ],
  papers: { enabled: true, id: 4 },
};

function mockFetchResponse(data: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  });
}

describe("useSources", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches sources on mount and returns data", async () => {
    mockFetch.mockReturnValueOnce(mockFetchResponse(POPULATED_RESPONSE));

    const { result } = renderHook(() => useSources());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(mockFetch).toHaveBeenCalledWith("/api/sources");
    expect(result.current.data).toEqual(POPULATED_RESPONSE);
    expect(result.current.error).toBeNull();
  });

  it("sets loading=true while fetching", () => {
    mockFetch.mockReturnValueOnce(new Promise(() => {})); // never resolves

    const { result } = renderHook(() => useSources());

    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();
  });

  it("sets error on fetch failure", async () => {
    mockFetch.mockReturnValueOnce(Promise.reject(new Error("Network error")));

    const { result } = renderHook(() => useSources());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe("Failed to load sources");
    expect(result.current.data).toBeNull();
  });

  it("addSource calls POST and appends to local state", async () => {
    mockFetch.mockReturnValueOnce(mockFetchResponse(EMPTY_RESPONSE));

    const { result } = renderHook(() => useSources());
    await waitFor(() => expect(result.current.loading).toBe(false));

    const newSource = { id: 10, type: "x_account", name: "New User", handle: "newuser", active: true, created_at: "2026-01-01T00:00:00Z" };
    mockFetch.mockReturnValueOnce(mockFetchResponse(newSource, 201));

    let success: boolean;
    await act(async () => {
      success = await result.current.addSource({ type: "x_account", name: "New User", handle: "newuser" });
    });

    expect(success!).toBe(true);
    expect(mockFetch).toHaveBeenLastCalledWith("/api/sources", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "x_account", name: "New User", handle: "newuser" }),
    });
    expect(result.current.data!.x_accounts).toHaveLength(1);
    expect(result.current.data!.x_accounts[0].handle).toBe("newuser");
  });

  it("addSource returns false and sets error on failure", async () => {
    mockFetch.mockReturnValueOnce(mockFetchResponse(EMPTY_RESPONSE));

    const { result } = renderHook(() => useSources());
    await waitFor(() => expect(result.current.loading).toBe(false));

    mockFetch.mockReturnValueOnce(mockFetchResponse({ error: "handle is required" }, 400));

    let success: boolean;
    await act(async () => {
      success = await result.current.addSource({ type: "x_account", name: "Bad" });
    });

    expect(success!).toBe(false);
    expect(result.current.error).toBe("handle is required");
  });

  it("removeSource calls DELETE and removes from local state", async () => {
    mockFetch.mockReturnValueOnce(mockFetchResponse(POPULATED_RESPONSE));

    const { result } = renderHook(() => useSources());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data!.x_accounts).toHaveLength(1);

    mockFetch.mockReturnValueOnce(mockFetchResponse({ success: true }));

    let success: boolean;
    await act(async () => {
      success = await result.current.removeSource(1);
    });

    expect(success!).toBe(true);
    expect(mockFetch).toHaveBeenLastCalledWith("/api/sources?id=1", { method: "DELETE" });
    expect(result.current.data!.x_accounts).toHaveLength(0);
  });

  it("removeSource returns false on failure", async () => {
    mockFetch.mockReturnValueOnce(mockFetchResponse(POPULATED_RESPONSE));

    const { result } = renderHook(() => useSources());
    await waitFor(() => expect(result.current.loading).toBe(false));

    mockFetch.mockReturnValueOnce(mockFetchResponse({ error: "Source not found" }, 404));

    let success: boolean;
    await act(async () => {
      success = await result.current.removeSource(999);
    });

    expect(success!).toBe(false);
    expect(result.current.error).toBe("Source not found");
  });

  it("togglePapers enables when disabled (POST)", async () => {
    mockFetch.mockReturnValueOnce(mockFetchResponse(EMPTY_RESPONSE));

    const { result } = renderHook(() => useSources());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data!.papers.enabled).toBe(false);

    const createdPapers = { id: 5, type: "papers", name: "Hugging Face Daily Papers", active: true, created_at: "2026-01-01T00:00:00Z" };
    mockFetch.mockReturnValueOnce(mockFetchResponse(createdPapers, 201));

    await act(async () => {
      await result.current.togglePapers();
    });

    expect(mockFetch).toHaveBeenLastCalledWith("/api/sources", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "papers", name: "Hugging Face Daily Papers" }),
    });
    expect(result.current.data!.papers.enabled).toBe(true);
    expect(result.current.data!.papers.id).toBe(5);
  });

  it("togglePapers disables when enabled (DELETE)", async () => {
    mockFetch.mockReturnValueOnce(mockFetchResponse(POPULATED_RESPONSE));

    const { result } = renderHook(() => useSources());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data!.papers.enabled).toBe(true);
    expect(result.current.data!.papers.id).toBe(4);

    mockFetch.mockReturnValueOnce(mockFetchResponse({ success: true }));

    await act(async () => {
      await result.current.togglePapers();
    });

    expect(mockFetch).toHaveBeenLastCalledWith("/api/sources?id=4", { method: "DELETE" });
    expect(result.current.data!.papers.enabled).toBe(false);
    expect(result.current.data!.papers.id).toBeNull();
  });
});
