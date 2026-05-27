import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { splitSqlStatements } from "../sql-statements";

describe("splitSqlStatements", () => {
  it("splits simple statements", () => {
    expect(splitSqlStatements("SELECT 1; SELECT 2;")).toEqual([
      "SELECT 1",
      "SELECT 2",
    ]);
  });

  it("does not split semicolons inside quotes or comments", () => {
    const statements = splitSqlStatements(`
      -- comment with ;
      SELECT 'one;two', "semi;colon";
      /* block ; comment */
      SELECT 'it''s still; one string';
    `);

    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("one;two");
    expect(statements[1]).toContain("still; one string");
  });

  it("does not split dollar-quoted function bodies", () => {
    const statements = splitSqlStatements(`
      CREATE OR REPLACE FUNCTION example()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$;

      CREATE TABLE IF NOT EXISTS example_table (id TEXT PRIMARY KEY);
    `);

    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("RETURN NEW;");
    expect(statements[1]).toContain("CREATE TABLE");
  });

  it("handles tagged dollar quotes inside DO blocks", () => {
    const statements = splitSqlStatements(`
      DO $$
      BEGIN
        EXECUTE $tag$
          UPDATE items SET value = 'a;b';
        $tag$;
      END;
      $$;

      SELECT 1;
    `);

    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("UPDATE items");
    expect(statements[1]).toBe("SELECT 1");
  });

  it("seeds the default papers source idempotently", () => {
    const migration = fs.readFileSync(
      path.join(process.cwd(), "db/migrations/008_default_papers_source.sql"),
      "utf-8",
    );

    expect(migration).toContain("Hugging Face Daily Papers");
    expect(migration).toContain("WHERE NOT EXISTS");
    expect(migration).toContain("type = 'papers'");
  });
});
