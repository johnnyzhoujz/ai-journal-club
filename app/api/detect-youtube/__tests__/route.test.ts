import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

import { POST } from "../route";

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/detect-youtube", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/detect-youtube", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- Channel URL patterns ---

  it("parses youtube.com/@handle as youtube_channel", async () => {
    const res = await POST(makeRequest({ url: "https://youtube.com/@lexfridman" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.type).toBe("youtube_channel");
    expect(json.channel_handle).toBe("lexfridman");
    expect(json.name).toBeNull();
  });

  it("parses www.youtube.com/@handle", async () => {
    const res = await POST(makeRequest({ url: "https://www.youtube.com/@lexfridman" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.type).toBe("youtube_channel");
    expect(json.channel_handle).toBe("lexfridman");
  });

  it("parses youtube.com/c/handle", async () => {
    const res = await POST(makeRequest({ url: "https://youtube.com/c/lexfridman" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.type).toBe("youtube_channel");
    expect(json.channel_handle).toBe("lexfridman");
  });

  it("parses youtube.com/channel/UCxxxxx", async () => {
    const res = await POST(makeRequest({ url: "https://youtube.com/channel/UC2eYFnH2wkFOpAMpf5gwOcw" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.type).toBe("youtube_channel");
    expect(json.channel_handle).toBe("UC2eYFnH2wkFOpAMpf5gwOcw");
  });

  // --- Playlist URL patterns ---

  it("parses youtube.com/playlist?list=PLxxx as youtube_playlist", async () => {
    const res = await POST(makeRequest({ url: "https://youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.type).toBe("youtube_playlist");
    expect(json.playlist_id).toBe("PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf");
  });

  it("parses www.youtube.com/playlist?list=PLxxx", async () => {
    const res = await POST(makeRequest({ url: "https://www.youtube.com/playlist?list=PL123abc" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.type).toBe("youtube_playlist");
    expect(json.playlist_id).toBe("PL123abc");
  });

  // --- Error cases ---

  it("returns 400 when URL is missing", async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
  });

  it("returns 400 for non-YouTube URL", async () => {
    const res = await POST(makeRequest({ url: "https://vimeo.com/123" }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toMatch(/youtube/i);
  });

  it("returns 400 for unrecognized YouTube URL pattern", async () => {
    const res = await POST(makeRequest({ url: "https://youtube.com/watch?v=abc123" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for youtube.com without path", async () => {
    const res = await POST(makeRequest({ url: "https://youtube.com" }));
    expect(res.status).toBe(400);
  });

  it("handles URL without https prefix", async () => {
    const res = await POST(makeRequest({ url: "youtube.com/@lexfridman" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.type).toBe("youtube_channel");
    expect(json.channel_handle).toBe("lexfridman");
  });

  it("handles trailing slash in URL", async () => {
    const res = await POST(makeRequest({ url: "https://youtube.com/@lexfridman/" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.channel_handle).toBe("lexfridman");
  });
});
