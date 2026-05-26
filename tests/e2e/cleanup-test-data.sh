#!/bin/bash
# Clean up E2E test data seeded by seed-test-data.sh.
# Deletes only the high-ID rows created for testing.

set -e

if [ -z "$DATABASE_URL" ]; then
    echo "SKIP: DATABASE_URL not set, cannot clean up test data"
    exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

node -e "
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);

async function cleanup() {
  await sql\`DELETE FROM digests WHERE id = 9000\`;
  await sql\`DELETE FROM feed_items WHERE id IN (9001, 9002, 9003)\`;
  await sql\`DELETE FROM sources WHERE id = 9000\`;
  console.log('E2E test data cleaned up successfully');
}

cleanup().catch(e => { console.error(e); process.exit(1); });
" 2>&1
