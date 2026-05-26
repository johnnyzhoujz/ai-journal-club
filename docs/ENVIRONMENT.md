# Environment

Copy `env.example` to `.env.local` for local development. Do not commit
`.env.local` or any file containing real secrets.

## Required

`DATABASE_URL`
Pooled Neon Postgres connection string used by the app at runtime.

`DATABASE_URL_UNPOOLED`
Direct Neon Postgres connection string preferred for schema setup and migrations.
The Vercel Neon integration can create both database variables automatically.

`ANTHROPIC_API_KEY`
Used for digest generation, research answers, deep dives, and paper synthesis.

`CRON_SECRET`
Shared secret for scheduled worker endpoints. Vercel Cron sends this value as
`Authorization: Bearer <CRON_SECRET>` when it is configured in the project.

`AUTH_PASSWORD`
The password for the simple built-in login screen.

`AUTH_SESSION_SECRET`
Secret used to sign session cookies. Generate a long random value, for example
with `openssl rand -base64 32`.

## Feature Credentials

`OPENAI_API_KEY`
Required for realtime audio briefings and optional embedding-backed memory.

`X_BEARER_TOKEN`
Required for X account ingestion and X profile lookup.

`SUPADATA_API_KEY`
Required for YouTube and podcast transcript ingestion.

## Optional Flags

Most features use sensible defaults. Keep optional flags unset unless you are
developing or operating that subsystem.

`PAPER_SEMANTIC_ENRICHMENT_ENABLED`
Set to `true` to let `/api/enrich-papers` perform LLM semantic enrichment.

`MEMORY_VECTOR_ENABLED`
Set to `true` only after pgvector is available and embeddings have been backfilled.
