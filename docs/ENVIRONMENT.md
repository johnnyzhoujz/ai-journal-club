# Environment

The Vercel deploy button creates the project, asks for the user-owned secrets,
and pre-fills the default feature flags. The Neon integration creates the
database variables.

For local development, pull the deployed project values instead of typing them
by hand:

```bash
vercel env pull .env.local
```

Do not commit `.env.local` or any file containing real secrets.

## User-Provided Values

| Variable | Use |
| --- | --- |
| `ANTHROPIC_API_KEY` | Digests, research answers, deep dives, paper synthesis, and semantic enrichment. |
| `OPENAI_API_KEY` | Realtime audio briefings and embeddings. |
| `AUTH_PASSWORD` | Password for the built-in login screen. |
| `AUTH_SESSION_SECRET` | Long random value for signing session cookies. |
| `CRON_SECRET` | Long random value used as `Authorization: Bearer <CRON_SECRET>` for scheduled workers. |

## Automatic Values

| Variable | Source |
| --- | --- |
| `DATABASE_URL` | Created by the Vercel Neon integration. |
| `DATABASE_URL_UNPOOLED` | Created by the Vercel Neon integration and used for schema setup. |
| `PAPER_SEMANTIC_ENRICHMENT_ENABLED=true` | Pre-filled by the deploy button. |
| `MEMORY_VECTOR_ENABLED=true` | Pre-filled by the deploy button. |
| `MEMORY_CHUNK_WRITES_ENABLED=true` | Pre-filled by the deploy button so new items write searchable memory chunks. |
| `MEMORY_READS_ENABLED=true` | Pre-filled by the deploy button so voice briefings can use memory search tools. |
| `PAPER_EVIDENCE_LAYER_ENABLED=true` | Pre-filled by the deploy button so enriched paper evidence is searchable. |

Vercel and Neon may also create provider-specific database variables such as
`DATABASE_POSTGRES_URL`, `DATABASE_POSTGRES_URL_NON_POOLING`, or
`DATABASE_NEON_PROJECT_ID`. They can stay in the Vercel project, but this app
does not read them directly.

## Optional Source Providers

| Variable | Add it when you want |
| --- | --- |
| `X_BEARER_TOKEN` | X account ingestion and X profile lookup. |
| `SUPADATA_API_KEY` | YouTube, playlist, podcast, and transcript ingestion. |
