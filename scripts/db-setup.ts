import fs from "fs";
import path from "path";
import { neon } from "@neondatabase/serverless";
import { splitSqlStatements } from "./sql-statements";

const MIGRATIONS_DIR = path.join(process.cwd(), "db", "migrations");

function loadLocalEnv() {
  for (const filename of [".env.local", ".env"]) {
    const filePath = path.join(process.cwd(), filename);
    if (!fs.existsSync(filePath)) {
      continue;
    }

    const lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const equalsAt = trimmed.indexOf("=");
      if (equalsAt === -1) {
        continue;
      }

      const key = trimmed.slice(0, equalsAt).trim();
      let value = trimmed.slice(equalsAt + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] ??= value;
    }
  }
}

function getDatabaseUrl() {
  loadLocalEnv();
  const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "Set DATABASE_URL_UNPOOLED or DATABASE_URL before running npm run db:setup",
    );
  }
  return url;
}

async function main() {
  const migrationFiles = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  if (migrationFiles.length === 0) {
    throw new Error(`No SQL migrations found in ${MIGRATIONS_DIR}`);
  }

  const sql = neon(getDatabaseUrl());

  for (const file of migrationFiles) {
    const sqlText = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8");
    const statements = splitSqlStatements(sqlText);
    console.log(`Applying ${file}`);
    for (const [index, statement] of statements.entries()) {
      try {
        await sql.query(statement);
      } catch (error) {
        throw new Error(
          `Failed applying ${file} statement ${index + 1}/${statements.length}`,
          { cause: error },
        );
      }
    }
  }

  const [counts] = await sql.query(
    "SELECT (SELECT COUNT(*)::int FROM feed_items) AS feed_items, (SELECT COUNT(*)::int FROM digests) AS digests",
  );
  console.log(
    `Database ready. feed_items=${counts.feed_items}, digests=${counts.digests}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
