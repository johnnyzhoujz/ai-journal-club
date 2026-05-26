# Database Setup

AI Journal Club starts from an empty Neon Postgres database. It does not require
or include a data dump.

## Apply Schema

Vercel deploys run this automatically through `npm run vercel:build`.

Set `DATABASE_URL_UNPOOLED` or `DATABASE_URL`, then run:

```bash
npm run db:setup
```

The setup script applies SQL files in `db/migrations` in lexical order. Migrations
are written to be safe to run more than once.

## Expected Empty State

After setup, the schema exists but content tables are empty:

- `feed_items` should contain `0` rows.
- `digests` should contain `0` rows.

Add sources through the Sources page, then fetch content through the dashboard or
scheduled jobs.
