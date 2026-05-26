import { NextRequest, NextResponse } from "next/server";

const X_API_BASE = "https://api.x.com/2";
const HANDLE_REGEX = /^[a-zA-Z0-9_]{1,15}$/;

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { handle } = body;
  if (!handle || typeof handle !== "string") {
    return NextResponse.json({ error: "handle is required" }, { status: 400 });
  }

  const cleaned = handle.replace(/^@/, "").trim();
  if (!cleaned || !HANDLE_REGEX.test(cleaned)) {
    return NextResponse.json(
      { error: "Invalid handle format. Use 1-15 alphanumeric characters or underscores." },
      { status: 400 },
    );
  }

  const bearerToken = process.env.X_BEARER_TOKEN;
  if (!bearerToken) {
    return NextResponse.json(
      { error: "X API not configured" },
      { status: 500 },
    );
  }

  try {
    const res = await fetch(
      `${X_API_BASE}/users/by?usernames=${cleaned}&user.fields=name,description`,
      {
        headers: { Authorization: `Bearer ${bearerToken}` },
        signal: AbortSignal.timeout(5000),
      },
    );

    if (!res.ok) {
      if (res.status === 429) {
        return NextResponse.json(
          { error: "X API rate limited. Try again later." },
          { status: 429 },
        );
      }
      return NextResponse.json(
        { error: `X API error: HTTP ${res.status}` },
        { status: 502 },
      );
    }

    const data = await res.json();
    const user = data.data?.[0];

    if (!user) {
      return NextResponse.json(
        { error: `User @${cleaned} not found on X` },
        { status: 404 },
      );
    }

    return NextResponse.json({
      name: user.name,
      handle: user.username,
      description: user.description || "",
    });
  } catch (err) {
    console.error("X profile detection failed:", err);
    return NextResponse.json(
      { error: "Failed to reach X API" },
      { status: 502 },
    );
  }
}
