# AI Journal Club

AI Journal Club is an open-source Next.js app for collecting AI research sources,
generating daily digests, searching the archive, and discussing a digest with a
realtime audio briefing.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fjohnnyzhoujz%2Fai-journal-club&project-name=ai-journal-club&repository-name=ai-journal-club&env=ANTHROPIC_API_KEY%2COPENAI_API_KEY%2CX_BEARER_TOKEN%2CSUPADATA_API_KEY%2CCRON_SECRET%2CAUTH_PASSWORD%2CAUTH_SESSION_SECRET&envDescription=AI+Journal+Club+needs+provider+keys+plus+app+auth+secrets.+Neon+can+provision+DATABASE_URL+and+DATABASE_URL_UNPOOLED+through+the+Vercel+integration.+See+docs%2FENVIRONMENT.md.&envLink=https%3A%2F%2Fgithub.com%2Fjohnnyzhoujz%2Fai-journal-club%2Fblob%2Fmain%2Fdocs%2FENVIRONMENT.md&products=%5B%7B%22type%22%3A%22integration%22%2C%22protocol%22%3A%22storage%22%2C%22productSlug%22%3A%22neon%22%2C%22integrationSlug%22%3A%22neon%22%7D%5D&skippable-integrations=1)

## Features

- Source management for X accounts, newsletters, YouTube channels, playlists,
  podcasts, and public paper feeds.
- Digest generation with source counts and archive links.
- Research search and deep-dive synthesis over your own database.
- Realtime audio briefing over the latest digest when OpenAI credentials are set.
- Idempotent schema bootstrap for a new Neon Postgres database.
- First-run setup panel that stores dismissal in localStorage and can be reopened
  from the Setup nav item.

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

Open `http://localhost:3000`, sign in with `AUTH_PASSWORD`, then use Setup and
Sources to finish configuration.

## Deploying

The Vercel button clones this repo and requests the required provider secrets. It
also requests the Neon native storage integration, which can provision
`DATABASE_URL` and `DATABASE_URL_UNPOOLED` for the project. If you skip the
integration, create a Neon project manually and add those variables yourself.

After the first deploy, run the schema setup once from a trusted machine:

```bash
vercel env pull .env.local
npm ci
npm run db:setup
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
