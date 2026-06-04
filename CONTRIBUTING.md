# Contributing

Thanks for improving AI Journal Club.

## Development

```bash
npm ci
npm test
npm run lint
npm run build
```

Keep changes public-safe. Do not commit env files, database dumps, generated
digests, private feed snapshots, local smoke reports, or deployment URLs.

Keep source-ingestion behavior consistent with the README's Content and
Copyright section: preserve attribution and source links where available, and do
not add UI or API defaults that expose raw cached full text wholesale, host
source PDFs, or position the app as a public full-text redistribution service.

## Pull Requests

- Explain the behavior change and validation performed.
- Include focused tests for user-facing or data-shape changes.
- Keep unrelated refactors out of the PR.
