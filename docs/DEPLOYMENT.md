# Deployment

## Vercel and Neon

Use the README deploy button to clone the repository into your own Git provider
and create a Vercel project. The button requests the Neon native storage
integration with the `neon` product. That integration provisions Postgres and
injects `DATABASE_URL` and `DATABASE_URL_UNPOOLED` before the Vercel build runs.

The deploy form only asks you to accept Neon and leave the default
research-memory and paper-evidence flags pre-filled as `true`. The app values
are added after the first deploy from the setup page.

## First Deploy

1. Click the README deploy button.
2. Accept the Neon integration.
3. Leave the pre-filled feature defaults as `true`.
4. Deploy.
5. Open the app. It shows Initial Setup because app credentials are not present
   yet.
6. Copy the generated `AUTH_SESSION_SECRET` and `CRON_SECRET`.
7. In Vercel Project Settings, add `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
   `AUTH_PASSWORD`, `AUTH_SESSION_SECRET`, and `CRON_SECRET`.
8. Redeploy once.
9. Open the app, sign in, and add sources.

The setup script applies every SQL file in `db/migrations` in order. It is
idempotent, so future deploys can run it again without importing sample data or
past digests. On the one-click path, Neon supplies the database values; the setup
page intentionally asks only for app credentials after deployment.

For local development against the same project, pull environment variables:

```bash
vercel env pull .env.local
```

## Updating an Existing Deployment

Vercel's one-click clone flow creates a repository under your own Git provider
account. That repository is usually an independent copy, not a GitHub fork, so
it does not automatically know that `johnnyzhoujz/ai-journal-club` is its
upstream source.

In a local checkout of your deployment repository, add the public repo as
`upstream` once:

```bash
git remote add upstream https://github.com/johnnyzhoujz/ai-journal-club.git
```

Then update from the public `main` branch whenever you want the latest release:

```bash
git fetch upstream
git checkout main
git merge upstream/main
git push origin main
```

If you have local customizations, resolve merge conflicts before pushing. If you
have no customizations and want your deployment repo to exactly match the public
repo, make a backup branch first:

```bash
git fetch upstream
git checkout main
git branch backup-before-upstream-sync
git reset --hard upstream/main
git push --force-with-lease origin main
```

After the push, Vercel should redeploy if the project is connected to that Git
repo. Deploys run `npm run vercel:build`, which reruns the idempotent database
setup against the same Neon database; it updates schema without replacing your
existing content.

## Cron Jobs

`vercel.json` registers these scheduled endpoints:

- `/api/fetch`
- `/api/hydrate-papers`
- `/api/enrich-papers`
- `/api/digest?requireReady=true`

Each endpoint requires `Authorization: Bearer <CRON_SECRET>`, matching Vercel
Cron behavior when `CRON_SECRET` is set.
