# Deployment

## Vercel and Neon

Use the README deploy button to clone the repository into your own Git provider
and create a Vercel project. The button requests the Neon native storage
integration with the `neon` product. That integration can provision Postgres and
inject `DATABASE_URL` and `DATABASE_URL_UNPOOLED`.

Credentials are added after the first deployment creates the Vercel project.
Open the deployed project in Vercel, go to Settings -> Environment Variables,
add the required values, and redeploy once so the serverless functions receive
the new environment. Before those values exist, the deployed app opens to Initial
Setup instead of asking for a password or trying to render the dashboard.

If you skip the integration, create a Neon Postgres project manually and add both
database URLs in Vercel Project Settings before redeploying.

## First Deploy

1. Click the README deploy button and accept the Neon integration.
2. Vercel creates the project, provisions the database, and runs
   `npm run db:setup` during the build through the `vercel:build` script, then
   runs `next build`.
3. After the first deployment succeeds, open the app from Vercel. It should show
   Initial Setup.
4. Open the Vercel project settings and add your environment variable values.
5. Redeploy the project.
6. Open the app, sign in, and add sources.

The setup script applies every SQL file in `db/migrations` in order. It is
idempotent, so future deploys can run it again without importing sample data or
past digests. A deploy fails early if neither `DATABASE_URL_UNPOOLED` nor
`DATABASE_URL` is available in the Vercel build environment.

For local development against the same project, pull environment variables:

```bash
vercel env pull .env.local
```

## Cron Jobs

`vercel.json` registers these scheduled endpoints:

- `/api/fetch`
- `/api/hydrate-papers`
- `/api/enrich-papers`
- `/api/digest?requireReady=true`

Each endpoint requires `Authorization: Bearer <CRON_SECRET>`, matching Vercel
Cron behavior when `CRON_SECRET` is set.
