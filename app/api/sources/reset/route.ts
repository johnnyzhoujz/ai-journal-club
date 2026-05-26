import { NextResponse } from "next/server";

export async function POST() {
  if (process.env.DATABASE_URL) {
    return NextResponse.json({ error: "Reset only available in mock mode" }, { status: 403 });
  }

  const { resetMockStore } = await import("@/lib/mock-store");
  resetMockStore();
  return NextResponse.json({ success: true });
}
