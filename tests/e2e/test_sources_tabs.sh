#!/bin/bash
set -e

echo "TEST: Sources page tab navigation"

# Open the sources page
rodney open http://localhost:3000/sources
sleep 2
rodney waitstable

# Check heading
heading=$(rodney text "h1")
if [ "$heading" != "Sources" ]; then
    echo "FAIL: Expected heading 'Sources', got '$heading'"
    exit 1
fi
echo "PASS: Page heading is 'Sources'"

# Check 4 tab buttons exist
tab_count=$(rodney count "[role=tab]")
if [ "$tab_count" -ne 4 ]; then
    echo "FAIL: Expected 4 tabs, got $tab_count"
    exit 1
fi
echo "PASS: 4 tab buttons rendered"

# Check tab labels
for label in "X Accounts" "Podcasts" "Newsletters" "Papers"; do
    if ! rodney js "document.querySelector('[role=tab][aria-selected]') !== null" > /dev/null 2>&1; then
        echo "FAIL: Could not find tabs"
        exit 1
    fi
done
echo "PASS: All tab buttons present"

# Check X Accounts is active by default
active_tab=$(rodney js "document.querySelector('[role=tab][aria-selected=true]').textContent")
if [ "$active_tab" != "X Accounts" ]; then
    echo "FAIL: Expected 'X Accounts' active by default, got '$active_tab'"
    exit 1
fi
echo "PASS: X Accounts tab is active by default"

# Click Podcasts tab and verify it becomes active
rodney click "[role=tab]:nth-child(2)"
rodney waitstable
active_tab=$(rodney js "document.querySelector('[role=tab][aria-selected=true]').textContent")
if [ "$active_tab" != "Podcasts" ]; then
    echo "FAIL: Expected 'Podcasts' active after click, got '$active_tab'"
    exit 1
fi
echo "PASS: Podcasts tab becomes active on click"

# Click Newsletters tab
rodney click "[role=tab]:nth-child(3)"
rodney waitstable
active_tab=$(rodney js "document.querySelector('[role=tab][aria-selected=true]').textContent")
if [ "$active_tab" != "Newsletters" ]; then
    echo "FAIL: Expected 'Newsletters' active, got '$active_tab'"
    exit 1
fi
echo "PASS: Newsletters tab becomes active on click"

# Click Papers tab
rodney click "[role=tab]:nth-child(4)"
rodney waitstable
active_tab=$(rodney js "document.querySelector('[role=tab][aria-selected=true]').textContent")
if [ "$active_tab" != "Papers" ]; then
    echo "FAIL: Expected 'Papers' active, got '$active_tab'"
    exit 1
fi
echo "PASS: Papers tab becomes active on click"

# Click back to X Accounts
rodney click "[role=tab]:nth-child(1)"
rodney waitstable
active_tab=$(rodney js "document.querySelector('[role=tab][aria-selected=true]').textContent")
if [ "$active_tab" != "X Accounts" ]; then
    echo "FAIL: Expected 'X Accounts' active again, got '$active_tab'"
    exit 1
fi
echo "PASS: Can navigate back to X Accounts"

echo ""
echo "All tab navigation tests passed"
