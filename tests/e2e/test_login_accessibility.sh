#!/bin/bash
set -e

echo "ACCESSIBILITY: Login page"

rodney open http://localhost:3000/login
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
    exit 1
fi
echo "PASS: All buttons have accessible names"

# Check form inputs have labels
rodney exists "label[for=password]" || { echo "FAIL: Password input missing label"; exit 1; }
echo "PASS: Password input has label"

# Check headings
rodney ax-find --role heading --json | python3 -c "
import json, sys
headings = json.load(sys.stdin)
if not headings:
    print('WARN: No headings found on page')
    sys.exit(0)
levels = [h.get('level', {}).get('value', 0) for h in headings]
print(f'PASS: Found {len(headings)} headings, levels: {levels}')
"

echo ""
echo "Login accessibility checks complete"
