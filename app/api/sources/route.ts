import { NextRequest, NextResponse } from "next/server";
import type { Source, SourceType, PodcastType } from "@/lib/schema";

const VALID_TYPES: SourceType[] = ["x_account", "podcast", "newsletter", "papers"];
const VALID_PODCAST_TYPES: PodcastType[] = ["youtube_channel", "youtube_playlist"];

function shouldMock() {
  return !process.env.DATABASE_URL;
}

function groupSources(rows: Source[]) {
  return {
    x_accounts: rows.filter((r) => r.type === "x_account"),
    podcasts: rows.filter((r) => r.type === "podcast"),
    newsletters: rows.filter((r) => r.type === "newsletter"),
    papers: {
      enabled: rows.some((r) => r.type === "papers"),
      id: rows.find((r) => r.type === "papers")?.id ?? null,
    },
  };
}

function validateSourceBody(body: Record<string, unknown>): string | null {
  const { type, name } = body;
  if (!name || typeof name !== "string" || !name.trim()) return "name is required";
  if (!type || typeof type !== "string") return "type is required";
  if (!VALID_TYPES.includes(type as SourceType))
    return `type must be one of: ${VALID_TYPES.join(", ")}`;

  switch (type) {
    case "x_account": {
      if (!body.handle || typeof body.handle !== "string") return "handle is required for x_account sources";
      const cleaned = body.handle.startsWith("@") ? body.handle.slice(1) : body.handle;
      if (!cleaned) return "handle cannot be empty";
      break;
    }
    case "podcast":
      if (!body.podcast_type || typeof body.podcast_type !== "string")
        return "podcast_type is required for podcast sources";
      if (!VALID_PODCAST_TYPES.includes(body.podcast_type as PodcastType))
        return "podcast_type must be youtube_channel or youtube_playlist";
      if (!body.url || typeof body.url !== "string") return "url is required for podcast sources";
      if (body.podcast_type === "youtube_channel" && (!body.channel_handle || typeof body.channel_handle !== "string"))
        return "channel_handle is required for youtube_channel podcasts";
      if (body.podcast_type === "youtube_playlist" && (!body.playlist_id || typeof body.playlist_id !== "string"))
        return "playlist_id is required for youtube_playlist podcasts";
      break;
    case "newsletter":
      if (!body.feed_url || typeof body.feed_url !== "string") return "feed_url is required for newsletter sources";
      break;
  }
  return null;
}

export async function GET() {
  if (shouldMock()) {
    const { getMockSources } = await import("@/lib/mock-store");
    return NextResponse.json(groupSources(getMockSources()));
  }

  try {
    const { sql } = await import("@/lib/db");
    const rows = await sql`SELECT * FROM sources WHERE active = TRUE ORDER BY created_at DESC` as Source[];
    return NextResponse.json(groupSources(rows));
  } catch (err) {
    console.error("Failed to fetch sources:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const error = validateSourceBody(body);
  if (error) {
    return NextResponse.json({ error }, { status: 400 });
  }

  if (shouldMock()) {
    try {
      const { addMockSource } = await import("@/lib/mock-store");
      const created = addMockSource(body);
      return NextResponse.json(created, { status: 201 });
    } catch (err: unknown) {
      if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "23505") {
        return NextResponse.json(
          { error: "Source with this handle or feed_url already exists" },
          { status: 409 }
        );
      }
      return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
  }

  // Strip leading @ from handle
  let handle = (body.handle as string) ?? null;
  if (handle && handle.startsWith("@")) {
    handle = handle.slice(1);
  }

  try {
    const { sql } = await import("@/lib/db");
    const rows = await sql`
      INSERT INTO sources (type, name, handle, podcast_type, channel_handle, playlist_id, url, feed_url)
      VALUES (${body.type}, ${body.name}, ${handle}, ${(body.podcast_type as string) ?? null},
              ${(body.channel_handle as string) ?? null}, ${(body.playlist_id as string) ?? null},
              ${(body.url as string) ?? null}, ${(body.feed_url as string) ?? null})
      RETURNING *
    `;
    return NextResponse.json(rows[0], { status: 201 });
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "23505") {
      return NextResponse.json(
        { error: "Source with this handle or feed_url already exists" },
        { status: 409 }
      );
    }
    console.error("Failed to create source:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  const idParam = request.nextUrl.searchParams.get("id");
  if (!idParam) {
    return NextResponse.json({ error: "Missing id parameter" }, { status: 400 });
  }

  const id = parseInt(idParam, 10);
  if (isNaN(id)) {
    return NextResponse.json({ error: "id must be a number" }, { status: 400 });
  }

  if (shouldMock()) {
    const { removeMockSource } = await import("@/lib/mock-store");
    const removed = removeMockSource(id);
    if (!removed) {
      return NextResponse.json({ error: "Source not found" }, { status: 404 });
    }
    return NextResponse.json({ success: true, source: removed });
  }

  try {
    const { sql } = await import("@/lib/db");
    const rows = await sql`
      UPDATE sources SET active = FALSE WHERE id = ${id} AND active = TRUE RETURNING *
    `;

    if (rows.length === 0) {
      return NextResponse.json({ error: "Source not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true, source: rows[0] });
  } catch (err) {
    console.error("Failed to delete source:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
