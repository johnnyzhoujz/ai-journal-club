# Deployment

## Vercel and Neon

Use the README deploy button to clone the repository into your own Git provider
and create a Vercel project. The button requests the Neon native storage
integration with the `neon` product. That integration can provision Postgres and
inject `DATABASE_URL` and `DATABASE_URL_UNPOOLED`.

If you skip the integration, create a Neon Postgres project manually and add both
database URLs in Vercel Project Settings before deploying.

## First Deploy

1. Deploy from Vercel.
2. Vercel runs `npm run db:setup` during the build through the `vercel:build`
   script, then runs `next build`.
3. Open the app, sign in, visit Setup, and add sources.

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
