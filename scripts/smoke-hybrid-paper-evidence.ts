/**
 * Read-only smoke test for hybrid paper-evidence SQL.
 *
 * This executes queryHybridPaperEvidenceRows against the configured Postgres
 * planner to verify the SQL is accepted. It is SELECT-only and uses a stub
 * vector, so it does not call the embedding API or mutate data.
 */

import fs from "node:fs/promises";

type SqlClient = typeof import("@/lib/db")["sql"];

async function loadEnvLocal(path = ".env.local") {
  let contents: string;
  try {
    contents = await fs.readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]] !== undefined) {
      continue;
    }
    const rawValue = match[2].trim();
    process.env[match[1]] = rawValue.replace(/^(['"])(.*)\1$/, "$2");
  }
}

async function pickPaperFeedItemIds(
  sql: SqlClient,
  limit = 3,
): Promise<number[]> {
  const rows = (await sql`
    SELECT DISTINCT pes.feed_item_id
    FROM paper_evidence_spans pes
    JOIN feed_items fi ON fi.id = pes.feed_item_id
    WHERE fi.source_type = 'paper'
      AND pes.embedding IS NOT NULL
    LIMIT ${limit}
  `) as { feed_item_id: number | string }[];

  return rows.map((row) => Number(row.feed_item_id));
}

async function main() {
  await loadEnvLocal();
  process.env.MEMORY_VECTOR_ENABLED = "true";
  process.env.PAPER_EVIDENCE_LAYER_ENABLED = "true";

  const [{ sql }, { queryHybridPaperEvidenceRows }] = await Promise.all([
    import("@/lib/db"),
    import("@/lib/memory-retrieval"),
  ]);

  console.log("== hybrid paper evidence SQL smoke ==");
  console.log(
    "DB:",
    process.env.DATABASE_URL?.split("@")[1]?.split("?")[0] ?? "(unknown)",
  );

  const feedItemIds = await pickPaperFeedItemIds(sql, 3);
  console.log("Sampled feed_item_ids:", feedItemIds);

  if (feedItemIds.length === 0) {
    console.error("No paper_evidence_spans with embeddings found. Cannot smoke.");
    process.exit(2);
  }

  const stubEmbedding = Array.from({ length: 1536 }, (_, index) => (index % 7) / 100);
  const queries = [
    "benchmark result",
    "what dataset did they use",
    "limitation of the approach",
  ];

  let failures = 0;
  for (const query of queries) {
    console.log(`\n-- query: ${JSON.stringify(query)}`);
    try {
      const rows = await queryHybridPaperEvidenceRows({
        feedItemIds,
        query,
        queryEmbedding: stubEmbedding,
        paperCorpusScope: "default",
        after: null,
        before: null,
        limitPerItem: 3,
      });
      console.log(`   OK - ${rows.length} row(s)`);
      if (rows[0]) {
        const preview = rows[0].text.slice(0, 80).replace(/\s+/g, " ");
        console.log(
          `   first row: feed_item=${rows[0].feed_item_id} span=${rows[0].paper_evidence.span_id} rrf=${rows[0].rrf_score.toFixed(4)} text="${preview}..."`,
        );
      }
    } catch (error) {
      failures += 1;
      console.error(
        `   FAIL: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  console.log(`\n== smoke done; failures=${failures} ==`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("smoke crashed:", error);
  process.exit(3);
});
