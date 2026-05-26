# Deployment

## Vercel and Neon

Use the README deploy button to clone the repository into your own Git provider
and create a Vercel project. The button requests the Neon native storage
integration with the `neon` product. That integration can provision Postgres and
inject `DATABASE_URL` and `DATABASE_URL_UNPOOLED`.

If you skip the integration, create a Neon Postgres project manually and add both
database URLs in Vercel Project Settings.

## First Deploy

1. Deploy from Vercel.
2. Pull environment variables locally.

```bash
vercel env pull .env.local
```

3. Apply the database schema.

```bash
npm ci
npm run db:setup
```

4. Open the app, sign in, visit Setup, and add sources.

## Cron Jobs

`vercel.json` registers these scheduled endpoints:

- `/api/fetch`
- `/api/hydrate-papers`
- `/api/enrich-papers`
- `/api/digest?requireReady=true`

Each endpoint requires `Authorization: Bearer <CRON_SECRET>`, matching Vercel
Cron behavior when `CRON_SECRET` is set.
