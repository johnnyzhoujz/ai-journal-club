# AI Journal Club

AI Journal Club turns the daily flood of AI papers into a private research
briefing you can read, search, and talk through. Deploy it once, add your API
keys, choose your sources, and let the app build a living archive of papers,
digests, and voice-ready context.

<p>
  <a href="https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fjohnnyzhoujz%2Fai-journal-club&project-name=ai-journal-club&repository-name=ai-journal-club&products=%5B%7B%22type%22%3A%22integration%22%2C%22protocol%22%3A%22storage%22%2C%22productSlug%22%3A%22neon%22%2C%22integrationSlug%22%3A%22neon%22%7D%5D&env=PAPER_SEMANTIC_ENRICHMENT_ENABLED%2CMEMORY_VECTOR_ENABLED%2CMEMORY_CHUNK_WRITES_ENABLED%2CMEMORY_READS_ENABLED%2CPAPER_EVIDENCE_LAYER_ENABLED&envDefaults=%7B%22PAPER_SEMANTIC_ENRICHMENT_ENABLED%22%3A%22true%22%2C%22MEMORY_VECTOR_ENABLED%22%3A%22true%22%2C%22MEMORY_CHUNK_WRITES_ENABLED%22%3A%22true%22%2C%22MEMORY_READS_ENABLED%22%3A%22true%22%2C%22PAPER_EVIDENCE_LAYER_ENABLED%22%3A%22true%22%7D&envDescription=Accept+Neon+and+deploy.+The+first+setup+page+will+show+the+app+environment+variables+to+add+in+one+pass.&envLink=https%3A%2F%2Fgithub.com%2Fjohnnyzhoujz%2Fai-journal-club%2Fblob%2Fmain%2Fdocs%2FENVIRONMENT.md">
    <img src="https://vercel.com/button" alt="Deploy with Vercel" width="220" />
  </a>
</p>

## What You Get

- A daily AI research digest that turns papers, newsletters, podcasts, X posts,
  and videos into one readable briefing.
- A realtime voice journal club that can explain the latest papers out loud and
  answer follow-up questions while you interrupt naturally.
- Paper-grounded deep dives for methods, results, limitations, related work, and
  "what should I read next?" questions.
- Persistent research memory, semantic enrichment, and vector search enabled by
  default on new deployments.
- Source management for public paper feeds, newsletters, podcasts, X accounts,
  YouTube channels, and YouTube playlists.
- One-click Vercel plus Neon deployment with schema setup and scheduled workers
  handled during deployment.

## One-Click Vercel Setup

Click **Deploy with Vercel** and accept the Neon database integration. Vercel
creates the project, provisions Postgres, runs the database setup, and installs
the scheduled jobs.

The deploy form only asks you to accept Neon and leave the pre-filled defaults as
`true`. You do not need to paste API keys or app secrets before the first
deployment.

After the first deployment finishes, open the Vercel URL. The setup page shows
the values to add in Vercel Project Settings:

| Value | Use |
| --- | --- |
| `ANTHROPIC_API_KEY` | Digests, deep dives, paper synthesis, and semantic enrichment. |
| `OPENAI_API_KEY` | Realtime voice briefing and embeddings. |
| `AUTH_PASSWORD` | The password for your app's login screen. |
| `AUTH_SESSION_SECRET` | Signs login cookies. |
| `CRON_SECRET` | Protects scheduled worker endpoints. |

The setup page generates `AUTH_SESSION_SECRET` and `CRON_SECRET` for you. Add
all five values in Vercel, redeploy once, then sign in with `AUTH_PASSWORD` and
add sources. The app starts with an empty database and fills it from the sources
you choose.

Optional source keys can be added later in Vercel Project Settings:

| Value | Add it when you want |
| --- | --- |
| `X_BEARER_TOKEN` | X account ingestion and X profile lookup. |
| `SUPADATA_API_KEY` | YouTube, playlist, podcast, and transcript ingestion. |

You should not need to create tables, paste database URLs, configure cron jobs,
or turn on the default research-memory features by hand. Leave the pre-filled
defaults as `true`.

## Local Development

You do not need a local checkout to use the deployed app. Local setup is only for
changing the code.

```bash
npm ci
vercel env pull .env.local
npm run dev
```

Open `http://localhost:3000` and sign in with the same `AUTH_PASSWORD` from your
Vercel environment.

Useful checks before opening a pull request:

```bash
npm test
npm run lint
npm run build
```

The repository intentionally contains no private feed snapshots, generated
digests, deployment URLs, database dumps, or local env files.

See [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md),
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md), and
[docs/DATABASE.md](docs/DATABASE.md) for operator details.
