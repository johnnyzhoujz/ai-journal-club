import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE_NAME, verifyAuthSessionToken } from "@/lib/auth";

const PUBLIC_PATHS = ["/login", "/api/auth/login", "/api/auth/logout"];
const CRON_PATHS = [
  "/api/fetch",
  "/api/digest",
  "/api/memory/backfill",
  "/api/hydrate-papers",
  "/api/enrich-papers",
];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Static assets pass through
  if (pathname.startsWith("/_next") || pathname === "/favicon.ico") {
    return NextResponse.next();
  }

  // Public paths pass through
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // CRON endpoints: allow if they have Bearer auth (they validate CRON_SECRET themselves)
  if (CRON_PATHS.some((p) => pathname.startsWith(p))) {
    if (request.headers.get("authorization")?.startsWith("Bearer ")) {
      return NextResponse.next();
    }
  }

  // Check cookie
  const authCookie = request.cookies.get(AUTH_COOKIE_NAME);
  if (authCookie?.value && (await verifyAuthSessionToken(authCookie.value))) {
    return NextResponse.next();
  }

  // API routes return 401 JSON
  if (pathname.startsWith("/api/")) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Pages redirect to login
  return NextResponse.redirect(new URL("/login", request.url));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
