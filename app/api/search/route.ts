import {
  searchArchiveForResearch,
  VALID_ARCHIVE_SEARCH_SOURCES,
  type ArchiveSearchSource,
} from "@/lib/archive-search";

const VALID_SOURCES = new Set<string>(VALID_ARCHIVE_SEARCH_SOURCES);

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  const q = searchParams.get("q")?.trim();
  if (!q) {
    return Response.json({ error: "Missing required query parameter: q" }, { status: 400 });
  }

  const source = (searchParams.get("source") ?? "all") as ArchiveSearchSource;
  if (!VALID_SOURCES.has(source)) {
    return Response.json(
      { error: `Invalid source type: ${source}. Must be one of: ${[...VALID_SOURCES].join(", ")}` },
      { status: 400 },
    );
  }

  const after = searchParams.get("after") ?? null;
  const before = searchParams.get("before") ?? null;
  const limitParam = parseInt(searchParams.get("limit") ?? "20", 10);
  const limit = Math.min(Math.max(isNaN(limitParam) ? 20 : limitParam, 1), 100);

  try {
    const results = await searchArchiveForResearch({
      query: q,
      source,
      after,
      before,
      limit,
    });

    return Response.json(results);
  } catch {
    return Response.json({ error: "Search query failed" }, { status: 500 });
  }
}
