#!/bin/bash
set -e

BASE_URL="${BASE_URL:-http://localhost:3000}"
echo "TEST: Login page — auth flow"

# Clear auth cookie via logout endpoint
rodney open "$BASE_URL/login"
rodney js "fetch('/api/auth/logout', { method: 'POST' })"
rodney sleep 0.5

# ─── State 1: Login page loads ────────────────────────────────────────────────
rodney open "$BASE_URL/login"
rodney waitstable

heading=$(rodney text "h1")
if [ -z "$heading" ]; then
    echo "FAIL: No h1 heading found on login page"
    exit 1
fi
echo "PASS: Login page has heading: '$heading'"

if ! rodney exists "input[type=password]"; then
    echo "FAIL: Password input not found"
    exit 1
fi
echo "PASS: Password input is present"

if ! rodney exists "button[type=submit]"; then
    echo "FAIL: Submit button not found"
    exit 1
fi
echo "PASS: Submit button is present"

# ─── State 2: Unauthenticated root redirects to /login ───────────────────────
rodney open "$BASE_URL/"
rodney waitstable

current_url=$(rodney url)
if [[ "$current_url" != *"/login"* ]]; then
    echo "FAIL: Expected redirect to /login, got $current_url"
    exit 1
fi
echo "PASS: Unauthenticated / redirects to /login"

# ─── State 3: Wrong password shows error ──────────────────────────────────────
rodney open "$BASE_URL/login"
rodney waitstable

rodney input "input[type=password]" "wrongpassword"
rodney click "button[type=submit]"
rodney waitstable
sleep 1

if rodney exists "p[class*=destructive]"; then
    error_text=$(rodney text "p[class*=destructive]")
    echo "PASS: Error shown for wrong password: '$error_text'"
else
    echo "FAIL: No error message displayed for wrong password"
    exit 1
fi

# ─── State 4: Correct password redirects to / ────────────────────────────────
rodney open "$BASE_URL/login"
rodney waitstable

rodney clear "input[type=password]"
rodney input "input[type=password]" "${AUTH_PASSWORD:-test123}"
rodney click "button[type=submit]"
rodney waitstable
sleep 1

current_url=$(rodney url)
if [[ "$current_url" == *"/login"* ]]; then
    echo "FAIL: Expected redirect away from /login after correct password, got $current_url"
    exit 1
fi
echo "PASS: Correct password redirects away from /login"

# ─── State 5: Authenticated user can access protected pages ──────────────────
rodney open "$BASE_URL/digests"
rodney waitstable

current_url=$(rodney url)
if [[ "$current_url" == *"/login"* ]]; then
    echo "FAIL: Authenticated user redirected to /login from /digests"
    exit 1
fi
echo "PASS: Authenticated user can access /digests"

rodney open "$BASE_URL/research"
rodney waitstable

current_url=$(rodney url)
if [[ "$current_url" == *"/login"* ]]; then
    echo "FAIL: Authenticated user redirected to /login from /research"
    exit 1
fi
echo "PASS: Authenticated user can access /research"

echo ""
echo "═══ All login page tests passed ═══"
