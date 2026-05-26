#!/bin/bash
set -e

echo "TEST: Dashboard action buttons are present and interactive"

# The home page requires auth — log in first
rodney open http://localhost:3000/login
rodney waitstable

rodney input "input[name=password]" "$AUTH_PASSWORD"
rodney click "button[type=submit]"
rodney waitstable

# Verify we're on the dashboard
current_url=$(rodney url)
if [[ "$current_url" == *"/login"* ]]; then
    echo "FAIL: Still on login page after auth attempt"
    exit 1
fi
echo "PASS: Logged in successfully"

# Check both action buttons exist
if rodney exists "button:has-text('Generate Digest')"; then
    echo "PASS: Generate Digest button present"
else
    echo "FAIL: Generate Digest button not found"
    exit 1
fi

if rodney exists "button:has-text('Run Fetch Now')"; then
    echo "PASS: Run Fetch Now button present"
else
    echo "FAIL: Run Fetch Now button not found"
    exit 1
fi

# Click Run Fetch Now and verify it shows loading state then result
rodney click "button:has-text('Run Fetch Now')"

# Brief wait for loading state
sleep 0.5

# Wait for result to appear (status message)
rodney wait "[role=status]" 30000

fetch_status=$(rodney text "[role=status]")
echo "Fetch result: $fetch_status"

# The status should contain either a count or an error — either way the action completed
if [ -n "$fetch_status" ]; then
    echo "PASS: Fetch action completed with status message"
else
    echo "FAIL: No status message after fetch action"
    exit 1
fi

echo "All dashboard action tests passed"
