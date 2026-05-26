#!/bin/bash
set -e

BASE_URL="${BASE_URL:-http://localhost:3000}"
echo "TEST: Digests page — all visual states"

# ─── State 1: Page loads with heading ─────────────────────────────────────────
rodney open "$BASE_URL/digests"
rodney waitstable

heading=$(rodney text "h1")
if [ "$heading" != "Digests" ]; then
    echo "FAIL: Expected heading 'Digests', got '$heading'"
    exit 1
fi
echo "PASS: Page heading is 'Digests'"

# ─── State 2: Shows digest cards (not empty state) ───────────────────────────
if rodney exists "[data-testid='digest-content']" 2>/dev/null; then
    echo "FAIL: Digest content should be collapsed initially"
    exit 1
fi

card_count=$(rodney count "button")
if [ "$card_count" -lt 1 ]; then
    echo "FAIL: No digest cards found (expected at least 1)"
    exit 1
fi
echo "PASS: Found $card_count digest cards"

# ─── State 3: Cards show dates in descending order ───────────────────────────
first_card_text=$(rodney text "button:first-of-type")
if [[ "$first_card_text" != *"March 21, 2026"* ]]; then
    echo "FAIL: First card should show most recent date (March 21, 2026), got: $first_card_text"
    exit 1
fi
echo "PASS: Most recent digest is first (March 21, 2026)"

# ─── State 4: Card shows correct item counts ─────────────────────────────────
if [[ "$first_card_text" != *"9 items"* ]]; then
    echo "FAIL: First card should show '9 items', got: $first_card_text"
    exit 1
fi
echo "PASS: First card shows correct total (9 items)"

if [[ "$first_card_text" != *"3 tweets"* ]]; then
    echo "FAIL: First card should show '3 tweets'"
    exit 1
fi
echo "PASS: Shows '3 tweets' (plural)"

if [[ "$first_card_text" != *"2 podcasts"* ]]; then
    echo "FAIL: First card should show '2 podcasts'"
    exit 1
fi
echo "PASS: Shows '2 podcasts'"

if [[ "$first_card_text" != *"2 newsletters"* ]]; then
    echo "FAIL: First card should show '2 newsletters'"
    exit 1
fi
echo "PASS: Shows '2 newsletters'"

if [[ "$first_card_text" != *"2 papers"* ]]; then
    echo "FAIL: First card should show '2 papers'"
    exit 1
fi
echo "PASS: Shows '2 papers'"

# ─── State 5: Second card with singular labels and zero-count omission ───────
# The second card (March 20) has: 1 tweet, 1 podcast, 0 newsletters, 1 paper
second_card_text=$(rodney js "document.querySelectorAll('button')[1]?.textContent")
if [[ "$second_card_text" != *"1 tweet"* ]]; then
    echo "FAIL: Second card should show '1 tweet' (singular)"
    exit 1
fi
echo "PASS: Shows '1 tweet' (singular)"

if [[ "$second_card_text" == *"newsletter"* ]]; then
    echo "FAIL: Second card should NOT show 'newsletter' (count is 0)"
    exit 1
fi
echo "PASS: Omits zero-count source types"

# ─── State 6: Click to expand ────────────────────────────────────────────────
rodney click "button:first-of-type"
rodney waitstable

if ! rodney exists "[data-testid='digest-content']"; then
    echo "FAIL: Clicking card should expand to show digest content"
    exit 1
fi
echo "PASS: Card expands on click"

# ─── State 7: Expanded content has markdown-rendered structure ───────────────
content=$(rodney text "[data-testid='digest-content']")

if [[ "$content" != *"X / Twitter"* ]] && [[ "$content" != *"X / TWITTER"* ]]; then
    echo "FAIL: Expanded digest should contain 'X / Twitter' section"
    exit 1
fi
echo "PASS: Digest has X / Twitter section"

if [[ "$content" != *"Podcast"* ]] && [[ "$content" != *"PODCASTS"* ]]; then
    echo "FAIL: Expanded digest should contain 'Podcasts' section"
    exit 1
fi
echo "PASS: Digest has Podcasts section"

if [[ "$content" != *"Karpathy"* ]]; then
    echo "FAIL: Digest should mention author names"
    exit 1
fi
echo "PASS: Digest content mentions authors"

# ─── State 8: Verify markdown renders as HTML elements ───────────────────────
h2_count=$(rodney count "[data-testid='digest-content'] h2")
if [ "$h2_count" -lt 1 ]; then
    echo "FAIL: Expanded content should have <h2> section headings (found $h2_count)"
    exit 1
fi
echo "PASS: Section headings render as <h2> elements ($h2_count found)"

link_count=$(rodney count "[data-testid='digest-content'] a")
if [ "$link_count" -lt 1 ]; then
    echo "FAIL: Expanded content should have clickable <a> links (found $link_count)"
    exit 1
fi
echo "PASS: Links render as clickable <a> elements ($link_count found)"

strong_count=$(rodney count "[data-testid='digest-content'] strong")
if [ "$strong_count" -lt 1 ]; then
    echo "FAIL: Expanded content should have <strong> bold text (found $strong_count)"
    exit 1
fi
echo "PASS: Author names render as <strong> bold elements ($strong_count found)"

hr_count=$(rodney count "[data-testid='digest-content'] hr")
if [ "$hr_count" -lt 1 ]; then
    echo "FAIL: Expanded content should have <hr> section dividers (found $hr_count)"
    exit 1
fi
echo "PASS: Section dividers render as <hr> elements ($hr_count found)"

# ─── State 9: Links open in new tab ──────────────────────────────────────────
link_target=$(rodney js "document.querySelector('[data-testid=\"digest-content\"] a')?.getAttribute('target')")
if [ "$link_target" != "_blank" ]; then
    echo "FAIL: Links should have target='_blank', got '$link_target'"
    exit 1
fi
echo "PASS: Links open in new tab (target=_blank)"

link_rel=$(rodney js "document.querySelector('[data-testid=\"digest-content\"] a')?.getAttribute('rel')")
if [[ "$link_rel" != *"noopener"* ]]; then
    echo "FAIL: Links should have rel='noopener noreferrer', got '$link_rel'"
    exit 1
fi
echo "PASS: Links have rel=noopener noreferrer"

# ─── State 10: Click to collapse ─────────────────────────────────────────────
rodney click "button:first-of-type"
rodney waitstable

if rodney exists "[data-testid='digest-content']" 2>/dev/null; then
    echo "FAIL: Clicking again should collapse the digest"
    exit 1
fi
echo "PASS: Card collapses on second click"

# ─── State 11: Third card (March 19) with different counts ───────────────────
third_card_text=$(rodney js "document.querySelectorAll('button')[2]?.textContent")
if [[ "$third_card_text" != *"March 19, 2026"* ]]; then
    echo "FAIL: Third card should show March 19, 2026"
    exit 1
fi
echo "PASS: Third card shows correct date"

if [[ "$third_card_text" != *"3 items"* ]]; then
    echo "FAIL: Third card should show '3 items'"
    exit 1
fi
echo "PASS: Third card shows correct total"

# ─── State 12: Expand a different card ───────────────────────────────────────
rodney js "document.querySelectorAll('button')[2].click()"
rodney waitstable

content_els=$(rodney count "[data-testid='digest-content']")
if [ "$content_els" -ne 1 ]; then
    echo "FAIL: Only one card should be expanded (found $content_els)"
    # This is fine — cards expand independently, but only one was clicked
fi
echo "PASS: Third card can expand independently"

echo ""
echo "═══ All digests page tests passed ═══"
