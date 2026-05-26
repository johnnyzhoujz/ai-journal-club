import { sql } from "@/lib/db";
import { DashboardActions } from "@/components/dashboard-actions";
import { DashboardDigest } from "@/components/dashboard-digest";
import { OnboardingPanel } from "@/components/onboarding-panel";
import type { Digest } from "@/lib/schema";

export const dynamic = "force-dynamic";

export default async function Home() {
  try {
    const [digestRows, sourceRows, fetchedRows, archiveRows] =
      await Promise.all([
        sql`SELECT * FROM digests ORDER BY generated_at DESC LIMIT 1`,
        sql`SELECT COUNT(*) as count FROM sources WHERE active = TRUE`,
        sql`SELECT COUNT(*) as count FROM feed_items WHERE fetched_at >= CURRENT_DATE`,
        sql`SELECT COUNT(*) as count FROM feed_items`,
      ]);

    const latestDigest = (digestRows as Digest[])[0] ?? null;
    const activeSources = Number((sourceRows as { count: number | string }[])[0]?.count ?? 0);
    const fetchedToday = Number((fetchedRows as { count: number | string }[])[0]?.count ?? 0);
    const totalArchive = Number((archiveRows as { count: number | string }[])[0]?.count ?? 0);

    return (
      <main className="mx-auto max-w-5xl w-full px-4 py-8">
        <OnboardingPanel />
        <h1 className="text-3xl font-bold mb-6">Dashboard</h1>

        <div className="grid grid-cols-3 gap-4 mb-8">
          <div className="rounded-lg border p-4">
            <p className="text-sm text-muted-foreground">Active Sources</p>
            <p className="text-2xl font-bold">{activeSources}</p>
          </div>
          <div className="rounded-lg border p-4">
            <p className="text-sm text-muted-foreground">Fetched Today</p>
            <p className="text-2xl font-bold">{fetchedToday}</p>
          </div>
          <div className="rounded-lg border p-4">
            <p className="text-sm text-muted-foreground">Total Archive</p>
            <p className="text-2xl font-bold">{totalArchive}</p>
          </div>
        </div>

        <DashboardActions />

        <section className="mt-8">
          <h2 className="text-xl font-semibold mb-4">Latest Digest</h2>
          {latestDigest ? (
            <DashboardDigest digest={latestDigest} />
          ) : (
            <div className="rounded-lg border p-6 text-center text-muted-foreground">
              <p>No digest yet.</p>
              <p className="text-sm mt-1">
                Generate your first digest using the button above.
              </p>
            </div>
          )}
        </section>
      </main>
    );
  } catch (error) {
    console.error("Dashboard failed to load:", error);
    return (
      <main className="mx-auto max-w-5xl w-full px-4 py-8">
        <OnboardingPanel />
        <h1 className="text-3xl font-bold mb-6">Dashboard</h1>
        <p className="text-destructive">
          Failed to load dashboard data. Please try again later.
        </p>
      </main>
    );
  }
}
