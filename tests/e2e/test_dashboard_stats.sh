#!/bin/bash
set -e

echo "TEST: Dashboard stat cards display correctly"

# Log in first — the home page requires auth
rodney open http://localhost:3000/login
rodney waitstable

rodney input "#password" "$AUTH_PASSWORD"
rodney click "button[type=submit]"
rodney waitstable

# Verify we're on the dashboard
current_url=$(rodney url)
if [[ "$current_url" == *"/login"* ]]; then
    echo "FAIL: Still on login page after auth attempt"
    exit 1
fi
echo "PASS: Logged in successfully"

# Check the Dashboard heading
heading=$(rodney text "h1")
if [[ "$heading" != *"Dashboard"* ]]; then
    echo "FAIL: Expected h1 to contain 'Dashboard', got '$heading'"
    exit 1
fi
echo "PASS: Dashboard heading present"

# Check all three stat cards exist with correct labels
stat_cards=$(rodney count ".rounded-lg.border")
if [ "$stat_cards" -lt 3 ]; then
    echo "FAIL: Expected at least 3 stat cards, found $stat_cards"
    exit 1
fi
echo "PASS: Found $stat_cards stat cards"

# Verify stat card labels
page_text=$(rodney js "document.body.innerText")

if [[ "$page_text" != *"Active Sources"* ]]; then
    echo "FAIL: 'Active Sources' label not found"
    exit 1
fi
echo "PASS: 'Active Sources' card present"

if [[ "$page_text" != *"Fetched Today"* ]]; then
    echo "FAIL: 'Fetched Today' label not found"
    exit 1
fi
echo "PASS: 'Fetched Today' card present"

if [[ "$page_text" != *"Total Archive"* ]]; then
    echo "FAIL: 'Total Archive' label not found"
    exit 1
fi
echo "PASS: 'Total Archive' card present"

# Verify both action buttons are present (use JS since :has-text is not standard CSS)
has_digest_btn=$(rodney js "!!Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Generate Digest'))")
if [ "$has_digest_btn" != "true" ]; then
    echo "FAIL: Generate Digest button not found"
    exit 1
fi
echo "PASS: Generate Digest button present"

has_fetch_btn=$(rodney js "!!Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Run Fetch Now'))")
if [ "$has_fetch_btn" != "true" ]; then
    echo "FAIL: Run Fetch Now button not found"
    exit 1
fi
echo "PASS: Run Fetch Now button present"

# Verify Regenerate button is present on the latest digest
has_regen_btn=$(rodney js "!!Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Regenerate'))")
if [ "$has_regen_btn" != "true" ]; then
    echo "FAIL: Regenerate button not found on latest digest"
    exit 1
fi
echo "PASS: Regenerate button present on latest digest"

# Accessibility: buttons have accessible names (text content or aria-label)
button_count=$(rodney count "button")
inaccessible_buttons=$(rodney js "Array.from(document.querySelectorAll('button')).filter(b => !b.textContent.trim() && !b.getAttribute('aria-label')).length")
if [ "$inaccessible_buttons" -gt 0 ]; then
    echo "FAIL: $inaccessible_buttons button(s) have no accessible name"
    exit 1
fi
echo "PASS: All $button_count buttons have accessible names"

# Accessibility: heading hierarchy — h1 should exist
if ! rodney exists "h1"; then
    echo "FAIL: No h1 heading found"
    exit 1
fi
echo "PASS: Heading hierarchy has h1"

echo ""
echo "All dashboard stat card tests passed"
