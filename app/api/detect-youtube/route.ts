import { NextRequest, NextResponse } from "next/server";

const ALLOWED_HOSTS = ["youtube.com", "www.youtube.com"];

interface ParsedYouTube {
  type: "youtube_channel" | "youtube_playlist";
  channel_handle?: string;
  playlist_id?: string;
}

function parseYouTubeUrl(urlStr: string): ParsedYouTube | null {
  let normalized = urlStr.trim().replace(/\/+$/, "");
  if (!normalized.startsWith("http")) {
    normalized = `https://${normalized}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return null;
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.includes(hostname)) {
    return null;
  }

  const path = parsed.pathname;

  // youtube.com/@handle
  const atHandle = path.match(/^\/@([^/]+)/);
  if (atHandle) {
    return { type: "youtube_channel", channel_handle: atHandle[1] };
  }

  // youtube.com/c/handle
  const cHandle = path.match(/^\/c\/([^/]+)/);
  if (cHandle) {
    return { type: "youtube_channel", channel_handle: cHandle[1] };
  }

  // youtube.com/channel/UCxxxxx
  const channelId = path.match(/^\/channel\/([^/]+)/);
  if (channelId) {
    return { type: "youtube_channel", channel_handle: channelId[1] };
  }

  // youtube.com/playlist?list=PLxxxxx
  if (path === "/playlist") {
    const listId = parsed.searchParams.get("list");
    if (listId) {
      return { type: "youtube_playlist", playlist_id: listId };
    }
  }

  return null;
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { url } = body;
  if (!url || typeof url !== "string") {
    return NextResponse.json({ error: "url is required" }, { status: 400 });
  }

  const result = parseYouTubeUrl(url);
  if (!result) {
    return NextResponse.json(
      { error: "Not a valid YouTube channel or playlist URL" },
      { status: 400 },
    );
  }

  // Normalize the URL
  let normalized = url.trim().replace(/\/+$/, "");
  if (!normalized.startsWith("http")) {
    normalized = `https://${normalized}`;
  }

  return NextResponse.json({
    ...result,
    url: normalized,
    name: null,
  });
}
