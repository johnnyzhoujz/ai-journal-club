#!/bin/bash
set -e

echo "TEST: Sources page accessibility"

rodney open http://localhost:3000/sources
sleep 2
rodney waitstable

# Check heading structure
echo ""
echo "Checking heading structure..."
heading_count=$(rodney ax-find --role heading --json 2>/dev/null | python3 -c "
import json, sys
headings = json.load(sys.stdin)
print(len(headings))
")

if [ "$heading_count" -lt 1 ]; then
    echo "FAIL: No headings found on page"
    exit 1
fi
echo "PASS: Found $heading_count heading(s)"

# Print heading details
rodney ax-find --role heading --json 2>/dev/null | python3 -c "
import json, sys
headings = json.load(sys.stdin)
for h in headings:
    level = h.get('level', {}).get('value', 'unknown')
    name = h.get('name', {}).get('value', 'unnamed')
    print(f'  Heading level {level}: {name}')
"

# Check all buttons have accessible names
echo ""
echo "Checking buttons have accessible names..."
unnamed_buttons=$(rodney ax-find --role button --json 2>/dev/null | python3 -c "
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

# Check tab buttons have proper ARIA attributes
echo ""
echo "Checking tab ARIA attributes..."
tab_count=$(rodney ax-find --role tab --json 2>/dev/null | python3 -c "
import json, sys
tabs = json.load(sys.stdin)
print(len(tabs))
")

if [ "$tab_count" -ne 4 ]; then
    echo "FAIL: Expected 4 tab roles, got $tab_count"
    exit 1
fi
echo "PASS: 4 elements with role=tab found"

# Print tab details
rodney ax-find --role tab --json 2>/dev/null | python3 -c "
import json, sys
tabs = json.load(sys.stdin)
for t in tabs:
    name = t.get('name', {}).get('value', 'unnamed')
    selected = t.get('selected', {}).get('value', 'unknown')
    print(f'  Tab: {name} (selected={selected})')
"

# Check tablist exists
tablist_count=$(rodney ax-find --role tablist --json 2>/dev/null | python3 -c "
import json, sys
try:
    tablists = json.load(sys.stdin)
    print(len(tablists))
except:
    print(0)
")

if [ "$tablist_count" -lt 1 ]; then
    echo "FAIL: No tablist role found"
    exit 1
fi
echo "PASS: tablist role present"

# Check form inputs have labels (switch to X Accounts tab which has the form)
echo ""
echo "Checking form input labels..."
rodney click "[role=tab]:nth-child(1)"
rodney waitstable

# Check for labeled text fields
labeled_inputs=$(rodney js "document.querySelectorAll('label[for]').length")
if [ "$labeled_inputs" -lt 2 ]; then
    echo "FAIL: Expected at least 2 labeled inputs on X Accounts form, got $labeled_inputs"
    exit 1
fi
echo "PASS: Form inputs have associated labels ($labeled_inputs found)"

# Verify each label points to an existing input
orphaned=$(rodney js "Array.from(document.querySelectorAll('label[for]')).filter(l => !document.getElementById(l.htmlFor)).length")
if [ "$orphaned" -gt 0 ]; then
    echo "FAIL: $orphaned label(s) point to non-existent input IDs"
    exit 1
fi
echo "PASS: All labels point to valid input IDs"

# Check Papers tab toggle has switch role
echo ""
echo "Checking Papers toggle accessibility..."
rodney click "[role=tab]:nth-child(4)"
rodney waitstable

switch_count=$(rodney ax-find --role switch --json 2>/dev/null | python3 -c "
import json, sys
switches = json.load(sys.stdin)
print(len(switches))
")

if [ "$switch_count" -lt 1 ]; then
    echo "FAIL: No switch role found on Papers tab"
    exit 1
fi
echo "PASS: Toggle has role=switch"

# Print switch details
rodney ax-find --role switch --json 2>/dev/null | python3 -c "
import json, sys
switches = json.load(sys.stdin)
for s in switches:
    checked = s.get('checked', {}).get('value', 'unknown')
    print(f'  Switch: checked={checked}')
"

echo ""
echo "All accessibility tests passed"
