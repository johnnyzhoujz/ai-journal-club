import { NextResponse } from "next/server";
import {
  AUTH_COOKIE_NAME,
  createAuthSessionToken,
  getAuthCookieOptions,
} from "@/lib/auth";

export async function POST(request: Request) {
  let body: { password?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { password } = body;
  if (!password) {
    return Response.json({ error: "Missing password" }, { status: 400 });
  }

  if (password !== process.env.AUTH_PASSWORD) {
    return Response.json({ error: "Invalid password" }, { status: 401 });
  }

  let sessionToken: string;

  try {
    sessionToken = await createAuthSessionToken();
  } catch {
    return Response.json({ error: "Auth is not configured" }, { status: 500 });
  }

  const response = NextResponse.json({ success: true });
  response.cookies.set(AUTH_COOKIE_NAME, sessionToken, getAuthCookieOptions());
  return response;
}
