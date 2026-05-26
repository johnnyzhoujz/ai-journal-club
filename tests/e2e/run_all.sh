#!/bin/bash
set -e

echo "━━━ Starting E2E test suite ━━━"
echo ""

# Seed test data if DATABASE_URL is available
if [ -n "$DATABASE_URL" ]; then
    echo "━━━ Seeding test data ━━━"
    bash tests/e2e/seed-test-data.sh
    echo ""
fi

rodney start
trap "rodney stop; [ -n '$DATABASE_URL' ] && bash tests/e2e/cleanup-test-data.sh" EXIT

PASS=0
FAIL=0

for test in tests/e2e/test_*.sh; do
    echo "━━━ Running: $test ━━━"
    if bash "$test"; then
        PASS=$((PASS + 1))
    else
        FAIL=$((FAIL + 1))
    fi
    echo ""
done

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "E2E Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
