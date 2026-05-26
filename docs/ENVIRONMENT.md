# Environment

Copy `env.example` to `.env.local` for local development. Do not commit
`.env.local` or any file containing real secrets.

For Vercel, deploy the template first so the project and Neon database exist.
The first deployed app opens to Initial Setup while these values are missing.
Then open the Vercel project, go to Settings -> Environment Variables, add the
values below, and redeploy once. Vercel environment variables need real values;
the deploy button can show variable names, but it cannot safely carry secret
values in the URL.

## Required

`DATABASE_URL`
Pooled Neon Postgres connection string used by the app at runtime.

`DATABASE_URL_UNPOOLED`
Direct Neon Postgres connection string preferred for schema setup and migrations.
The Vercel Neon integration can create both database variables automatically.

`ANTHROPIC_API_KEY`
Used for digest generation, research answers, deep dives, and paper synthesis.

`OPENAI_API_KEY`
Required for realtime audio briefings and embedding-backed memory features. This
enables the voice journal club experience where the app can explain the latest
papers out loud and answer follow-up questions in conversation.

`CRON_SECRET`
Shared secret for scheduled worker endpoints. Vercel Cron sends this value as
`Authorization: Bearer <CRON_SECRET>` when it is configured in the project.

`AUTH_PASSWORD`
The password for the simple built-in login screen.

`AUTH_SESSION_SECRET`
Secret used to sign session cookies. Generate a long random value, for example
with `openssl rand -base64 32`.

## Optional Ingestion Credentials

`X_BEARER_TOKEN`
Optional. Add only if you want X account ingestion and X profile lookup.

`SUPADATA_API_KEY`
Optional. Add only if you want YouTube, playlist, podcast, and transcript
ingestion.

## Optional Flags

Most features use sensible defaults. Keep optional flags unset unless you are
developing or operating that subsystem.

`PAPER_SEMANTIC_ENRICHMENT_ENABLED`
Set to `true` to let `/api/enrich-papers` perform LLM semantic enrichment.

`MEMORY_VECTOR_ENABLED`
Set to `true` only after pgvector is available and embeddings have been backfilled.
