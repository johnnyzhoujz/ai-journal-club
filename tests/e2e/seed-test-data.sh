#!/bin/bash
# Seed minimal test data for E2E tests.
# Uses high IDs (9000+) to avoid conflicts with production data.
# Idempotent via ON CONFLICT DO NOTHING.

set -e

if [ -z "$DATABASE_URL" ]; then
    echo "SKIP: DATABASE_URL not set, cannot seed test data"
    exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

node -e "
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);

async function seed() {
  await sql\`INSERT INTO sources (id, type, name, handle, active) VALUES (9000, 'x_account', 'E2E Test Account', 'e2e_test', TRUE) ON CONFLICT DO NOTHING\`;

  await sql\`INSERT INTO feed_items (id, source_type, external_id, source_id, title, content, url, author_name, author_handle, published_at, fetched_at) VALUES
    (9001, 'tweet', 'e2e_tweet_1', 9000, NULL, 'E2E test tweet about AI builders', 'https://x.com/e2e_test/status/9001', 'E2E Test', 'e2e_test', NOW() - INTERVAL '1 hour', NOW() - INTERVAL '1 hour'),
    (9002, 'podcast', 'e2e_podcast_1', 9000, 'E2E Test Podcast', 'E2E test podcast transcript about machine learning', 'https://youtube.com/watch?v=e2e9002', 'E2E Test', NULL, NOW() - INTERVAL '2 hours', NOW() - INTERVAL '2 hours'),
    (9003, 'paper', 'e2e_paper_1', 9000, 'E2E Test Paper', 'E2E test paper abstract about neural networks', 'https://arxiv.org/abs/e2e.9003', 'E2E Test', NULL, NOW() - INTERVAL '3 hours', NOW() - INTERVAL '3 hours')
    ON CONFLICT DO NOTHING\`;

  await sql\`INSERT INTO digests (id, content, item_count, tweet_count, podcast_count, newsletter_count, paper_count, source_item_ids, model, generated_at) VALUES
    (9000, '# E2E Test Digest\n\nThis is a test digest for end-to-end testing.\n\n## Key Highlights\n\n- AI builders are shipping fast\n- New ML techniques emerging\n- Research papers on neural architectures', 3, 1, 1, 0, 1, ARRAY[9001, 9002, 9003], 'claude-haiku-4-5-20251001', NOW())
    ON CONFLICT DO NOTHING\`;

  console.log('E2E test data seeded successfully');
}

seed().catch(e => { console.error(e); process.exit(1); });
" 2>&1
