#!/bin/bash
set -e

echo "TEST: Login flow — cookie set and redirect works"

# 1. Unauthenticated visit to / should redirect to /login
rodney open http://localhost:3000/
rodney waitstable

current_url=$(rodney url)
if [[ "$current_url" != *"/login"* ]]; then
    echo "FAIL: Expected redirect to /login, got $current_url"
    exit 1
fi
echo "PASS: Unauthenticated / redirects to /login"

# 2. Login page has password input and submit button
rodney exists "input#password" || { echo "FAIL: Password input not found"; exit 1; }
echo "PASS: Password input present"

rodney exists "button[type=submit]" || { echo "FAIL: Submit button not found"; exit 1; }
echo "PASS: Submit button present"

# 3. Wrong password shows error
rodney input "input#password" "wrong-password"
rodney click "button[type=submit]"
rodney waitstable
sleep 1

if rodney exists ".text-destructive"; then
    error_text=$(rodney text ".text-destructive")
    echo "PASS: Error shown for wrong password: $error_text"
else
    echo "FAIL: No error message for wrong password"
    exit 1
fi

# 4. Correct password — should redirect to / (dashboard)
rodney open http://localhost:3000/login
rodney waitstable

rodney clear "input#password"
rodney input "input#password" "test-e2e-password"
rodney click "button[type=submit]"
sleep 3
rodney waitstable

current_url=$(rodney url)
if [[ "$current_url" == *"/login"* ]]; then
    echo "FAIL: Still on /login after correct password. URL: $current_url"
    exit 1
fi
echo "PASS: Logged in, redirected to: $current_url"

# 5. Refresh should stay authenticated (cookie persists)
rodney open http://localhost:3000/
rodney waitstable

current_url=$(rodney url)
if [[ "$current_url" == *"/login"* ]]; then
    echo "FAIL: Redirected back to /login on refresh — cookie not persisted"
    exit 1
fi
echo "PASS: Cookie persists across page loads"

echo ""
echo "All login flow tests passed"
