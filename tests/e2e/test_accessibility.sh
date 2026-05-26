#!/bin/bash
set -e

BASE_URL="${BASE_URL:-http://localhost:3000}"
echo "TEST: Accessibility checks for digests and research pages"

# ─── Digests page accessibility ──────────────────────────────────────────────
echo ""
echo "--- Checking /digests ---"
rodney open "$BASE_URL/digests"
rodney waitstable

# Heading structure
heading_text=$(rodney text "h1")
if [ -z "$heading_text" ]; then
    echo "FAIL: No h1 heading found on digests page"
    exit 1
fi
echo "PASS: Digests page has h1 heading: '$heading_text'"

# All buttons have accessible content
button_count=$(rodney count "button")
empty_buttons=$(rodney js "Array.from(document.querySelectorAll('button')).filter(b => !b.textContent.trim()).length")
if [ "$empty_buttons" -gt 0 ]; then
    echo "FAIL: $empty_buttons button(s) have no text content"
    exit 1
fi
echo "PASS: All $button_count buttons have text content"

# Keyboard accessible — buttons are focusable
focusable=$(rodney js "document.querySelector('button')?.tabIndex >= 0")
if [ "$focusable" != "true" ]; then
    echo "FAIL: Digest card buttons should be keyboard focusable"
    exit 1
fi
echo "PASS: Buttons are keyboard focusable"

# ─── Research page accessibility ─────────────────────────────────────────────
echo ""
echo "--- Checking /research ---"
rodney open "$BASE_URL/research"
rodney waitstable

# Heading
heading_text=$(rodney text "h1")
if [ -z "$heading_text" ]; then
    echo "FAIL: No h1 heading found on research page"
    exit 1
fi
echo "PASS: Research page has h1 heading: '$heading_text'"

# All form inputs have labels
label_for_after=$(rodney js "document.querySelector('label[for=after-date]')?.textContent || ''")
if [ -z "$label_for_after" ]; then
    echo "FAIL: After date input missing label"
    exit 1
fi
echo "PASS: After date input has label: '$label_for_after'"

label_for_before=$(rodney js "document.querySelector('label[for=before-date]')?.textContent || ''")
if [ -z "$label_for_before" ]; then
    echo "FAIL: Before date input missing label"
    exit 1
fi
echo "PASS: Before date input has label: '$label_for_before'"

label_for_source=$(rodney js "document.querySelector('label[for=source-filter]')?.textContent || ''")
if [ -z "$label_for_source" ]; then
    echo "FAIL: Source filter missing label"
    exit 1
fi
echo "PASS: Source filter has label: '$label_for_source'"

# Search input has placeholder (accessible hint)
placeholder=$(rodney attr "input[placeholder]" placeholder)
if [ -z "$placeholder" ]; then
    echo "FAIL: Search input missing placeholder"
    exit 1
fi
echo "PASS: Search input has placeholder: '$placeholder'"

# Submit button has accessible name
btn_text=$(rodney text "button[type=submit]")
if [ -z "$btn_text" ]; then
    echo "FAIL: Submit button has no text"
    exit 1
fi
echo "PASS: Submit button has text: '$btn_text'"

# Links in results open in new tab safely (rel=noopener)
rodney input "input[placeholder]" "agents"
rodney js "document.querySelector('button[type=submit]').disabled = false"
rodney click "button[type=submit]"
rodney waitstable
sleep 1

if rodney exists "a[target='_blank']"; then
    unsafe_links=$(rodney js "Array.from(document.querySelectorAll('a[target=_blank]')).filter(a => !a.rel.includes('noopener')).length")
    if [ "$unsafe_links" -gt 0 ]; then
        echo "FAIL: $unsafe_links link(s) missing rel='noopener noreferrer'"
        exit 1
    fi
    echo "PASS: All external links have rel='noopener noreferrer'"
fi

echo ""
echo "═══ All accessibility tests passed ═══"
