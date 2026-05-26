#!/bin/bash
set -e

echo "TEST: Sources page interactive flows (add/remove/toggle)"

# Reset mock store to seed data before each run
curl -s -X POST http://localhost:3000/api/sources/reset > /dev/null

rodney open http://localhost:3000/sources
sleep 2
rodney waitstable

# --- Verify seed data loads ---
echo ""
echo "Checking seed data loads..."

if ! rodney exists "text=Andrej Karpathy" 2>/dev/null; then
    # Try finding by text content
    page_text=$(rodney js "document.body.textContent")
    if [[ "$page_text" != *"Andrej Karpathy"* ]]; then
        echo "FAIL: Seed X account 'Andrej Karpathy' not found on page"
        exit 1
    fi
fi
echo "PASS: Seed X account data loaded"

# Check @karpathy handle is displayed
handle_text=$(rodney js "document.body.textContent")
if [[ "$handle_text" != *"@karpathy"* ]]; then
    echo "FAIL: @karpathy handle not displayed"
    exit 1
fi
echo "PASS: @karpathy handle displayed"

# --- Add a new X account ---
echo ""
echo "Testing: Add new X account..."

rodney input "#x_account-name" "Yann LeCun"
rodney input "#x-handle" "ylecun"
rodney click "button[type=submit]"
sleep 1
rodney waitstable

# Verify the new source appears in the list
page_text=$(rodney js "document.body.textContent")
if [[ "$page_text" != *"Yann LeCun"* ]]; then
    echo "FAIL: Newly added 'Yann LeCun' not found in list"
    exit 1
fi
echo "PASS: New X account 'Yann LeCun' added and appears in list"

# Check form cleared after submission
name_val=$(rodney js "document.getElementById('x_account-name').value")
if [ "$name_val" != "" ]; then
    echo "FAIL: Name field not cleared after submission (value='$name_val')"
    exit 1
fi
echo "PASS: Form cleared after successful submission"

# --- Remove a source ---
echo ""
echo "Testing: Remove a source..."

# Count remove buttons before
remove_count_before=$(rodney count "button[aria-label^=Remove]")
echo "  Remove buttons before: $remove_count_before"

# Click the first remove button
rodney click "button[aria-label^=Remove]"
sleep 1
rodney waitstable

# Count remove buttons after
remove_count_after=$(rodney count "button[aria-label^=Remove]")
echo "  Remove buttons after: $remove_count_after"

if [ "$remove_count_after" -ge "$remove_count_before" ]; then
    echo "FAIL: Source was not removed (buttons before=$remove_count_before, after=$remove_count_after)"
    exit 1
fi
echo "PASS: Source removed from list"

# --- Switch to Podcasts tab and verify data ---
echo ""
echo "Testing: Podcasts tab with seed data..."

rodney click "[role=tab]:nth-child(2)"
rodney waitstable

page_text=$(rodney js "document.body.textContent")
if [[ "$page_text" != *"Lex Fridman"* ]]; then
    echo "FAIL: Seed podcast 'Lex Fridman Podcast' not found on Podcasts tab"
    exit 1
fi
echo "PASS: Seed podcast data loaded on Podcasts tab"

# --- Switch to Newsletters tab and verify data ---
echo ""
echo "Testing: Newsletters tab with seed data..."

rodney click "[role=tab]:nth-child(3)"
rodney waitstable

page_text=$(rodney js "document.body.textContent")
if [[ "$page_text" != *"The Batch"* ]]; then
    echo "FAIL: Seed newsletter 'The Batch' not found on Newsletters tab"
    exit 1
fi
echo "PASS: Seed newsletter data loaded on Newsletters tab"

# --- Switch to Papers tab and test toggle ---
echo ""
echo "Testing: Papers toggle..."

rodney click "[role=tab]:nth-child(4)"
rodney waitstable

# Papers should be enabled (from seed data)
checked=$(rodney js "document.querySelector('[role=switch]').getAttribute('aria-checked')")
if [ "$checked" != "true" ]; then
    echo "FAIL: Papers toggle should be ON from seed data (aria-checked=$checked)"
    exit 1
fi
echo "PASS: Papers toggle is ON (matching seed data)"

# Toggle papers OFF
rodney click "[role=switch]"
sleep 1
rodney waitstable

checked=$(rodney js "document.querySelector('[role=switch]').getAttribute('aria-checked')")
if [ "$checked" != "false" ]; then
    echo "FAIL: Papers toggle should be OFF after click (aria-checked=$checked)"
    exit 1
fi
echo "PASS: Papers toggle turned OFF"

# Toggle papers back ON
rodney click "[role=switch]"
sleep 1
rodney waitstable

checked=$(rodney js "document.querySelector('[role=switch]').getAttribute('aria-checked')")
if [ "$checked" != "true" ]; then
    echo "FAIL: Papers toggle should be ON again (aria-checked=$checked)"
    exit 1
fi
echo "PASS: Papers toggle turned back ON"

echo ""
echo "All interactive flow tests passed"
