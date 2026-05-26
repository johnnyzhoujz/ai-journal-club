# API Route Verification — /api/fetch and /api/digest

*2026-03-21T22:54:37Z by Showboat 0.6.1*
<!-- showboat-id: 0c7e1054-e42c-4f61-9ac0-712d79d80460 -->

Verify that the /api/fetch and /api/digest routes still reject unauthenticated requests (important: these routes serve the Vercel cron job).

```bash
./node_modules/.bin/vitest run app/api/fetch/__tests__/route.test.ts 2>&1 | grep -E '(✓|✗|Tests|passed|failed)' | tail -5
```

```output
 ✓ app/api/fetch/__tests__/route.test.ts (15 tests) 8ms
 Test Files  1 passed (1)
      Tests  15 passed (15)
```

```bash
./node_modules/.bin/vitest run app/api/digest/__tests__/route.test.ts 2>&1 | grep -E '(✓|✗|Tests|passed|failed)' | tail -5
```

```output
 ✓ app/api/digest/__tests__/route.test.ts (12 tests) 8ms
 Test Files  1 passed (1)
      Tests  12 passed (12)
```

Both API routes pass all tests including auth validation. The /api/fetch route now delegates to fetchAllContent() from lib/fetch-content.ts while preserving the same auth checks and response shape for the Vercel cron job.
