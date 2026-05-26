import { sql } from "@/lib/db";
import { DigestCard } from "@/components/digest-card";
import type { Digest } from "@/lib/schema";

export const dynamic = "force-dynamic";

export default async function DigestsPage() {
  let digests: Digest[];
  try {
    digests = (await sql`SELECT * FROM digests ORDER BY generated_at DESC`) as Digest[];
  } catch (error) {
    console.error("Digests page failed to load:", error);
    return (
      <main className="w-full mx-auto max-w-3xl px-4 py-8">
        <h1 className="text-2xl font-bold mb-6">Digests</h1>
        <p className="text-destructive">
          Failed to load digests. Please try again later.
        </p>
      </main>
    );
  }

  return (
    <main className="w-full mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-bold mb-6">Digests</h1>
      {digests.length === 0 ? (
        <p className="text-muted-foreground text-sm py-8 text-center">
          No digests yet.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {digests.map((digest) => (
            <DigestCard key={digest.id} digest={digest} />
          ))}
        </div>
      )}
    </main>
  );
}
