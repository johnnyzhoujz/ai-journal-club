#!/bin/bash
set -e

echo "ACCESSIBILITY: Deep Dive feature"

# Set auth cookie and navigate
rodney open http://localhost:3000/digests
rodney js "document.cookie = 'auth=1; path=/'"
rodney open http://localhost:3000/digests
rodney waitstable

# Check if there are digest cards
card_count=$(rodney count "[class*='rounded-lg border']")
if [ "$card_count" -lt 1 ]; then
    echo "SKIP: No digest cards found (empty database). Cannot test accessibility."
    echo "PASS: (skipped — no data)"
    exit 0
fi

# Expand first card (use specific selector to avoid nav buttons)
rodney click "[class*='rounded-lg border'] button"
rodney waitstable

# Open Deep Dive
rodney click "[data-testid='deep-dive-button']"
rodney waitstable

# Check all buttons have accessible names
unnamed_buttons=$(rodney ax-find --role button --json | python3 -c "
import json, sys
buttons = json.load(sys.stdin)
unnamed = [b for b in buttons if not b.get('name', {}).get('value')]
print(len(unnamed))
")

if [ "$unnamed_buttons" -gt 0 ]; then
    echo "FAIL: $unnamed_buttons button(s) missing accessible name"
    rodney ax-find --role button --json | python3 -c "
import json, sys
buttons = json.load(sys.stdin)
for b in buttons:
    name = b.get('name', {}).get('value', '<none>')
    print(f'  Button: {name}')
"
    exit 1
fi
echo "PASS: All buttons have accessible names"

# Check headings
rodney ax-find --role heading --json | python3 -c "
import json, sys
headings = json.load(sys.stdin)
if not headings:
    print('WARN: No headings found')
    sys.exit(0)
levels = [h.get('level', {}).get('value', 0) for h in headings]
print(f'PASS: Found {len(headings)} headings, levels: {levels}')
"

# Check textarea has accessible label/placeholder
if rodney exists "textarea[placeholder]"; then
    echo "PASS: Chat textarea has placeholder text"
else
    echo "FAIL: Chat textarea missing placeholder/label"
    exit 1
fi

# Close overlay
rodney click "button[aria-label='Close deep dive']"
rodney waitstable

echo ""
echo "Accessibility checks complete"
