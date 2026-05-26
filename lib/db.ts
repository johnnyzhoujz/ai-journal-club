import { neon } from "@neondatabase/serverless";

let _sql: ReturnType<typeof neon> | null = null;

function getSql() {
  if (!_sql) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error("DATABASE_URL environment variable is required");
    }
    _sql = neon(url);
  }
  return _sql;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function sql(strings: TemplateStringsArray, ...values: unknown[]): any {
  return getSql()(strings, ...values);
}

export function transaction(
  queries: Parameters<ReturnType<typeof neon>["transaction"]>[0],
) {
  return getSql().transaction(queries);
}
