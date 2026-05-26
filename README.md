# AI Journal Club

AI Journal Club is an open-source Next.js app for collecting AI research sources,
generating daily digests, searching the archive, and discussing a digest with a
realtime audio briefing.

<p>
  <a href="https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fjohnnyzhoujz%2Fai-journal-club&project-name=ai-journal-club&repository-name=ai-journal-club&products=%5B%7B%22type%22%3A%22integration%22%2C%22protocol%22%3A%22storage%22%2C%22productSlug%22%3A%22neon%22%2C%22integrationSlug%22%3A%22neon%22%7D%5D&skippable-integrations=1">
    <img src="https://vercel.com/button" alt="Deploy with Vercel" width="220" />
  </a>
</p>

The deploy button creates your Vercel project and asks Vercel to provision a Neon
Postgres database. After that first deployment finishes, the app opens to Initial
Setup until the required environment variables are set and the dashboard can
load. Add your own environment variable values in Vercel, redeploy once, and the
app will open to the dashboard.

## Features

- Audio-first journal club experience: a realtime voice agent walks through the
  latest AI papers, explains the high-level ideas clearly, and lets you interrupt
  or ask follow-up questions while it is speaking.
- Paper deep dives in conversation: ask about a specific result, method,
  limitation, or related idea and get answers grounded in the papers stored in
  your own database.
- Daily digest generation with source counts and archive links.
- Source management for public paper feeds, newsletters, podcasts, X accounts,
  YouTube channels, and YouTube playlists. X and YouTube ingestion require your
  own provider API keys.
- Idempotent schema bootstrap for a new Neon Postgres database.
- Dedicated Initial Setup page for deployment credentials and source-provider
  guidance.

## One-click Vercel setup

The Vercel deploy button handles the infrastructure: it clones the repo into your
Git provider, creates the Vercel project, connects the Neon integration, and runs
the database schema setup during the first build. You do not need to create
tables, cron routes, or a separate database by hand when the Neon integration is
accepted.

The one manual step is credentials. Vercel needs a project before you can add the
real secret values that make the app usable. Once deployment succeeds:

1. Open the deployed app. It should land on Initial Setup, not the dashboard.
2. Open the newly created Vercel project.
3. Go to Settings -> Environment Variables.
4. Add the required variables below.
5. Redeploy the project so the app can read the new values.
6. Open the deployed app, sign in with `AUTH_PASSWORD`, and use Sources to choose
   what should appear in your daily journal club.

Required for the core app:

| Variable | What it does |
| --- | --- |
| `DATABASE_URL` | Runtime Neon database URL. Usually created by the Vercel Neon integration. |
| `DATABASE_URL_UNPOOLED` | Direct Neon database URL for schema setup. Usually created by the Vercel Neon integration. |
| `AUTH_PASSWORD` | Password for the built-in login screen. |
| `AUTH_SESSION_SECRET` | Long random secret for signing session cookies. |
| `CRON_SECRET` | Shared secret Vercel Cron uses when calling scheduled worker endpoints. |
| `ANTHROPIC_API_KEY` | Digest generation, research answers, deep dives, and paper synthesis. |
| `OPENAI_API_KEY` | Realtime voice briefing and embedding-backed memory features. |

Optional source credentials:

| Variable | Add it when you want... |
| --- | --- |
| `X_BEARER_TOKEN` | X account ingestion and X profile lookup. |
| `SUPADATA_API_KEY` | YouTube, playlist, podcast, and transcript ingestion. |

Optional feature flags:

| Variable | Default |
| --- | --- |
| `PAPER_SEMANTIC_ENRICHMENT_ENABLED` | `false` |
| `MEMORY_VECTOR_ENABLED` | `false` |

Vercel's deploy button can list environment variable names for users to fill, but
it cannot safely pass secret values through the URL. This template therefore
keeps the button focused on creating the project and database, then asks you to
add values inside your own Vercel project.

## Quick Start

1. Install dependencies.

```bash
npm ci
```

2. Create a local env file.

```bash
cp env.example .env.local
```

3. Fill in at least `DATABASE_URL`, `DATABASE_URL_UNPOOLED`,
   `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CRON_SECRET`, `AUTH_PASSWORD`, and
   `AUTH_SESSION_SECRET`.

4. Bootstrap the database.

```bash
npm run db:setup
```

5. Start the app.

```bash
npm run dev
```

Open `http://localhost:3000`, sign in with `AUTH_PASSWORD`, then use Initial
Setup and Sources to finish configuration.

## Deploying

The Vercel button clones this repo and requests the Neon native storage
integration, which can provision `DATABASE_URL` and `DATABASE_URL_UNPOOLED` for
the project. Vercel runs `npm run db:setup` automatically during deployment
before `next build`, so a new Neon database is bootstrapped with an empty schema
on first deploy. If you skip the integration, create a Neon project manually and
add those variables yourself before redeploying.

For local development against that Vercel project, pull the same environment
variables:

```bash
vercel env pull .env.local
```

See [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md) and
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for details.

## Scheduled Jobs

`vercel.json` registers cron jobs for fetch, paper hydration, semantic enrichment,
and digest generation. Set `CRON_SECRET`; Vercel sends it to cron endpoints as a
Bearer authorization header.

## Development

```bash
npm test
npm run lint
npm run build
```

The repository intentionally contains no private feed snapshots, generated
digests, deployment URLs, database dumps, or local env files.
