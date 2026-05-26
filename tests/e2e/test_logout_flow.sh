#!/bin/bash
set -e

echo "TEST: Logout flow — cookie cleared and redirect works"

# Must be logged in first
rodney open http://localhost:3000/login
rodney waitstable
rodney input "input#password" "test-e2e-password"
rodney click "button[type=submit]"
sleep 3
rodney waitstable

# Verify we're logged in
current_url=$(rodney url)
if [[ "$current_url" == *"/login"* ]]; then
    echo "FAIL: Could not log in to set up logout test"
    exit 1
fi
echo "PASS: Logged in for logout test"

# Call logout API via JS (since there may not be a logout button on every page)
rodney js "fetch('/api/auth/logout', { method: 'POST' })"
sleep 1

# Now navigating to / should redirect to /login
rodney open http://localhost:3000/
rodney waitstable

current_url=$(rodney url)
if [[ "$current_url" != *"/login"* ]]; then
    echo "FAIL: Expected redirect to /login after logout, got $current_url"
    exit 1
fi
echo "PASS: Logged out, redirected to /login"

echo ""
echo "All logout flow tests passed"
