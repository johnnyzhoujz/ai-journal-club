# AI Journal Club

AI Journal Club turns the daily flood of AI papers into a private educational
and informational briefing you can read, search, and talk through. Deploy it
once, add your API keys, choose your sources, and let the app build a living
archive of papers, digests, and voice-ready context.

<p>
  <a href="https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fjohnnyzhoujz%2Fai-journal-club&project-name=ai-journal-club&repository-name=ai-journal-club&products=%5B%7B%22type%22%3A%22integration%22%2C%22protocol%22%3A%22storage%22%2C%22productSlug%22%3A%22neon%22%2C%22integrationSlug%22%3A%22neon%22%7D%5D&env=PAPER_SEMANTIC_ENRICHMENT_ENABLED%2CMEMORY_VECTOR_ENABLED%2CMEMORY_CHUNK_WRITES_ENABLED%2CMEMORY_READS_ENABLED%2CPAPER_EVIDENCE_LAYER_ENABLED&envDefaults=%7B%22PAPER_SEMANTIC_ENRICHMENT_ENABLED%22%3A%22true%22%2C%22MEMORY_VECTOR_ENABLED%22%3A%22true%22%2C%22MEMORY_CHUNK_WRITES_ENABLED%22%3A%22true%22%2C%22MEMORY_READS_ENABLED%22%3A%22true%22%2C%22PAPER_EVIDENCE_LAYER_ENABLED%22%3A%22true%22%7D&envDescription=Accept+Neon+and+deploy.+The+first+setup+page+will+show+the+app+environment+variables+to+add+in+one+pass.&envLink=https%3A%2F%2Fgithub.com%2Fjohnnyzhoujz%2Fai-journal-club%2Fblob%2Fmain%2Fdocs%2FENVIRONMENT.md">
    <img src="https://vercel.com/button" alt="Deploy with Vercel" width="220" />
  </a>
</p>

## What You Get

- A daily AI papers digest that turns papers, newsletters, podcasts, X posts,
  and videos into one readable briefing.
- A realtime voice journal club that can explain the latest papers out loud and
  answer follow-up questions while you interrupt naturally.
- Voice follow-ups that can go deeper on paper methods, results, limitations,
  related work, and "what should I read next?" questions.
- Persistent paper memory, semantic enrichment, and vector search enabled by
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
| `ANTHROPIC_API_KEY` | Digests, paper synthesis, and semantic enrichment. |
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
or turn on the default memory and evidence features by hand. Leave the pre-filled
defaults as `true`.

## Content and Copyright

AI Journal Club is designed for educational and informational purposes. It helps
users understand, summarize, search, and discuss papers from configured upstream
sources.

The app stores paper metadata, source links, abstracts, generated digests,
knowledge notes, and other generated outputs. For private retrieval, evidence
search, and synthesis, it may also cache extracted full text and derived chunks
inside the user's deployment database. The app does not store or serve source
PDFs, is not designed to expose raw cached full text wholesale through the
normal UI or API, and is not designed to operate as a public full-text paper
archive, PDF host, or replacement distribution channel for source papers.

All source works remain owned by their respective authors, publishers,
platforms, or rights holders. The MIT license in this repository applies only to
the AI Journal Club software code and does not grant rights to third-party
papers, datasets, articles, media, or other source materials accessed through
the app.

Users are responsible for ensuring that their use of configured sources complies
with applicable laws, licenses, and platform terms. Generated outputs should
cite and link back to the original source rather than replace it.

## Acknowledgements

AI Journal Club began as an early fork and substantial rework of
[Follow Builders](https://github.com/zarazhangrui/follow-builders), an
MIT-licensed AI builders digest project. See [NOTICE.md](NOTICE.md) for
third-party notice details. The current app has since been redesigned around
private paper ingestion, retrieval, evidence search, voice briefings, and
self-hosted Vercel/Neon deployment.

## Updating an Existing Deployment

The Vercel deploy flow creates your own Git repository for the app. That private
deployment repo does not automatically stay connected to this public repository
as a GitHub fork.

If your deployment repo includes the **Sync from upstream** workflow, open
GitHub Actions in that repo, select **Sync from upstream**, and click **Run
workflow**. It opens a pull request with the latest public updates so you can
review and merge them.

You can also sync from a local checkout by adding this repo as `upstream` once:

```bash
git remote add upstream https://github.com/johnnyzhoujz/ai-journal-club.git
git fetch upstream
git checkout main
git merge upstream/main
git push origin main
```

Pushing to your deployment repo's `main` branch should trigger a Vercel redeploy
if the project is connected to Git. The build reruns the idempotent database
setup, so schema updates apply without replacing your existing Neon data.

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
