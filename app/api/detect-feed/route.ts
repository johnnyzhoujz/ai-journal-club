import { NextRequest, NextResponse } from "next/server";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MB

const BLOCKED_HOSTS = [
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "[::1]",
  "metadata.google.internal",
  "169.254.169.254",
];

const PRIVATE_IP_PREFIXES = ["10.", "172.16.", "172.17.", "172.18.", "172.19.", "172.20.", "172.21.", "172.22.", "172.23.", "172.24.", "172.25.", "172.26.", "172.27.", "172.28.", "172.29.", "172.30.", "172.31.", "192.168."];

function isBlockedUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return true;
    const hostname = parsed.hostname.toLowerCase();
    if (BLOCKED_HOSTS.includes(hostname)) return true;
    if (PRIVATE_IP_PREFIXES.some((p) => hostname.startsWith(p))) return true;
    if (hostname.endsWith(".local") || hostname.endsWith(".internal")) return true;
    return false;
  } catch {
    return true;
  }
}

async function limitedText(response: Response): Promise<string> {
  const contentLength = response.headers.get("Content-Length");
  if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_BYTES) {
    throw new Error("Response too large");
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_RESPONSE_BYTES) {
    throw new Error("Response too large");
  }
  return new TextDecoder().decode(buffer);
}

function isXml(contentType: string, body: string): boolean {
  return (
    contentType.includes("xml") ||
    contentType.includes("rss") ||
    body.trimStart().startsWith("<?xml") ||
    body.trimStart().startsWith("<rss") ||
    body.trimStart().startsWith("<feed")
  );
}

function extractXmlTitle(xml: string): string | null {
  // Prefer <channel><title> over any other <title> for RSS feeds
  const channelTitle = xml.match(/<channel>[^]*?<title>([^<]+)<\/title>/i);
  if (channelTitle) return channelTitle[1].trim();
  const match = xml.match(/<title>([^<]+)<\/title>/i);
  return match ? match[1].trim() : null;
}

function extractRssLink(
  html: string,
  baseUrl: string
): { feedUrl: string; name: string | null } | null {
  // Match <link> tags with rel="alternate" and type containing rss+xml
  const linkRegex =
    /<link[^>]*rel=["']alternate["'][^>]*type=["']application\/rss\+xml["'][^>]*\/?>/gi;
  const linkRegexAlt =
    /<link[^>]*type=["']application\/rss\+xml["'][^>]*rel=["']alternate["'][^>]*\/?>/gi;

  const match = linkRegex.exec(html) || linkRegexAlt.exec(html);
  if (!match) return null;

  const tag = match[0];
  const hrefMatch = tag.match(/href=["']([^"']+)["']/i);
  if (!hrefMatch) return null;

  let feedUrl = hrefMatch[1];
  // Resolve relative URLs
  if (feedUrl.startsWith("/")) {
    const base = new URL(baseUrl);
    feedUrl = `${base.origin}${feedUrl}`;
  } else if (!feedUrl.startsWith("http")) {
    feedUrl = new URL(feedUrl, baseUrl).href;
  }

  const titleMatch = tag.match(/title=["']([^"']+)["']/i);
  let name = titleMatch ? titleMatch[1] : null;

  // Fall back to page <title>
  if (!name) {
    const pageTitleMatch = html.match(/<title>([^<]+)<\/title>/i);
    name = pageTitleMatch ? pageTitleMatch[1].trim() : null;
  }

  return { feedUrl, name };
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

  // Block non-http schemes before normalization
  if (url.match(/^[a-z]+:/i) && !url.match(/^https?:/i)) {
    return NextResponse.json({ error: "URL not allowed" }, { status: 400 });
  }

  // Normalize URL
  let normalizedUrl = url.replace(/\/+$/, "");
  if (!normalizedUrl.startsWith("http")) {
    normalizedUrl = `https://${normalizedUrl}`;
  }

  if (isBlockedUrl(normalizedUrl)) {
    return NextResponse.json({ error: "URL not allowed" }, { status: 400 });
  }

  // Step 1: Try Substack convention (${url}/feed)
  const feedPath = `${normalizedUrl}/feed`;
  if (!isBlockedUrl(feedPath)) {
    try {
      const feedRes = await fetch(feedPath, {
        signal: AbortSignal.timeout(5000),
      });
      if (feedRes.ok) {
        const text = await limitedText(feedRes);
        const contentType = feedRes.headers.get("Content-Type") || "";
        if (isXml(contentType, text)) {
          const name = extractXmlTitle(text);
          return NextResponse.json({ feedUrl: feedPath, name });
        }
      }
    } catch (err) {
      console.error("Feed detection: /feed fetch failed:", err);
    }
  }

  // Step 2: Fallback — parse HTML for <link rel="alternate" type="application/rss+xml">
  try {
    const pageRes = await fetch(normalizedUrl, {
      signal: AbortSignal.timeout(5000),
    });
    if (pageRes.ok) {
      const html = await limitedText(pageRes);
      const result = extractRssLink(html, normalizedUrl);
      if (result) {
        return NextResponse.json(result);
      }
    }
  } catch (err) {
    console.error("Feed detection: page fetch failed:", err);
    return NextResponse.json(
      { error: "Failed to fetch URL" },
      { status: 502 }
    );
  }

  return NextResponse.json(
    { error: "No RSS feed found at this URL" },
    { status: 404 }
  );
}
