#!/bin/bash
set -e

BASE_URL="${BASE_URL:-http://localhost:3000}"
echo "TEST: Research page — all visual states"

# ─── State 1: Page loads with heading and form ───────────────────────────────
rodney open "$BASE_URL/research"
rodney waitstable

heading=$(rodney text "h1")
if [ "$heading" != "Research" ]; then
    echo "FAIL: Expected heading 'Research', got '$heading'"
    exit 1
fi
echo "PASS: Page heading is 'Research'"

# ─── State 2: Form elements present ─────────────────────────────────────────
if ! rodney exists "input[placeholder]"; then
    echo "FAIL: Search input not found"
    exit 1
fi
echo "PASS: Search input present"

if ! rodney exists "select#source-filter"; then
    echo "FAIL: Source filter dropdown not found"
    exit 1
fi
echo "PASS: Source filter dropdown present"

if ! rodney exists "input#after-date"; then
    echo "FAIL: After date input not found"
    exit 1
fi
echo "PASS: After date input present"

if ! rodney exists "input#before-date"; then
    echo "FAIL: Before date input not found"
    exit 1
fi
echo "PASS: Before date input present"

# ─── State 3: Source filter has all 5 options ────────────────────────────────
option_count=$(rodney count "select#source-filter option")
if [ "$option_count" -ne 5 ]; then
    echo "FAIL: Expected 5 source filter options, got $option_count"
    exit 1
fi
echo "PASS: Source filter has 5 options (All, Tweet, Podcast, Newsletter, Paper)"

# ─── State 4: Search button disabled when empty ─────────────────────────────
is_disabled=$(rodney js "document.querySelector('button[type=submit]').disabled")
if [ "$is_disabled" != "true" ]; then
    echo "FAIL: Search button should be disabled when query is empty"
    exit 1
fi
echo "PASS: Search button disabled when empty"

# ─── State 5: Typing enables button ─────────────────────────────────────────
rodney input "input[placeholder]" "agents"
rodney waitstable

is_disabled=$(rodney js "document.querySelector('button[type=submit]').disabled")
if [ "$is_disabled" != "false" ]; then
    echo "FAIL: Search button should be enabled after typing"
    exit 1
fi
echo "PASS: Search button enabled after typing"

# ─── State 6: Search returns results ────────────────────────────────────────
rodney click "button[type=submit]"
rodney waitstable
sleep 1  # wait for API response

# Check results appeared
if ! rodney exists "a[target='_blank']"; then
    echo "FAIL: No search results links found after searching 'agents'"
    exit 1
fi

result_count=$(rodney count "a[target='_blank']")
if [ "$result_count" -lt 1 ]; then
    echo "FAIL: Expected at least 1 result for 'agents'"
    exit 1
fi
echo "PASS: Search returned $result_count results for 'agents'"

# ─── State 7: Results show author names ──────────────────────────────────────
page_text=$(rodney js "document.body.textContent")

if [[ "$page_text" != *"swyx"* ]]; then
    echo "FAIL: Results should show author 'swyx'"
    exit 1
fi
echo "PASS: Results show author name (swyx)"

if [[ "$page_text" != *"Lex Fridman"* ]]; then
    echo "FAIL: Results should show author 'Lex Fridman'"
    exit 1
fi
echo "PASS: Results show author name (Lex Fridman)"

# ─── State 8: Results show source type badges ───────────────────────────────
if [[ "$page_text" != *"tweet"* ]]; then
    echo "FAIL: Results should show 'tweet' badge"
    exit 1
fi
echo "PASS: Results show source type badge (tweet)"

if [[ "$page_text" != *"podcast"* ]]; then
    echo "FAIL: Results should show 'podcast' badge"
    exit 1
fi
echo "PASS: Results show source type badge (podcast)"

# ─── State 9: Results have snippet text with highlights ──────────────────────
bold_count=$(rodney count "b")
if [ "$bold_count" -lt 1 ]; then
    echo "FAIL: Snippets should have bold highlighted terms"
    exit 1
fi
echo "PASS: Snippets contain bold highlighted search terms ($bold_count highlights)"

# ─── State 10: Results link to original sources ─────────────────────────────
first_link_href=$(rodney attr "a[target='_blank']" href)
if [[ "$first_link_href" != http* ]]; then
    echo "FAIL: Result links should point to original source URLs, got: $first_link_href"
    exit 1
fi
echo "PASS: Results link to original sources ($first_link_href)"

# ─── State 11: Synthesize button appears ────────────────────────────────────
if ! rodney exists "button:not([type=submit])"; then
    echo "WARN: Synthesize button not found (may be expected without ANTHROPIC_API_KEY)"
fi

synth_text=$(rodney js "Array.from(document.querySelectorAll('button')).find(b => /synthesize/i.test(b.textContent))?.textContent || 'NOT_FOUND'")
if [[ "$synth_text" == *"Synthesize"* ]]; then
    echo "PASS: Synthesize button appears after results"
else
    echo "WARN: Synthesize button not found (OK if ANTHROPIC_API_KEY not set)"
fi

# ─── State 12: Filter by source type ────────────────────────────────────────
rodney select "select#source-filter" "tweet"
rodney click "button[type=submit]"
rodney waitstable
sleep 1

# All results should be tweets only
badges=$(rodney js "Array.from(document.querySelectorAll('a[target=_blank] span:first-child')).map(s => s.textContent).join(',')")
if [[ "$badges" == *"podcast"* ]] || [[ "$badges" == *"newsletter"* ]] || [[ "$badges" == *"paper"* ]]; then
    echo "FAIL: Filtering by 'tweet' should only show tweets, got badges: $badges"
    exit 1
fi
echo "PASS: Source filter 'tweet' shows only tweet results"

# ─── State 13: Search with no results ───────────────────────────────────────
rodney select "select#source-filter" "all"
rodney clear "input[placeholder]"
rodney input "input[placeholder]" "xyznonexistent123"
rodney click "button[type=submit]"
rodney waitstable
sleep 1

no_results_text=$(rodney js "document.body.textContent")
if [[ "$no_results_text" != *"No results found"* ]]; then
    echo "FAIL: Searching for non-existent term should show 'No results found'"
    exit 1
fi
echo "PASS: Shows 'No results found' for non-matching query"

# ─── State 14: Previous results cleared ──────────────────────────────────────
if [[ "$no_results_text" == *"swyx"* ]]; then
    echo "FAIL: Previous results should be cleared on new search"
    exit 1
fi
echo "PASS: Previous results cleared on new search"

# ─── State 15: Search for a different term ───────────────────────────────────
rodney clear "input[placeholder]"
rodney input "input[placeholder]" "scaling"
rodney click "button[type=submit]"
rodney waitstable
sleep 1

page_text=$(rodney js "document.body.textContent")
if [[ "$page_text" != *"scaling"* ]] && [[ "$page_text" != *"Scaling"* ]] && [[ "$page_text" != *"No results found"* ]]; then
    echo "FAIL: Searching 'scaling' should show results or 'No results found'"
    exit 1
fi
echo "PASS: Search for 'scaling' works"

# ─── State 16: Results show dates ────────────────────────────────────────────
rodney clear "input[placeholder]"
rodney input "input[placeholder]" "agents"
rodney click "button[type=submit]"
rodney waitstable
sleep 1

page_text=$(rodney js "document.body.textContent")
if [[ "$page_text" != *"March"* ]] && [[ "$page_text" != *"2026"* ]]; then
    echo "FAIL: Results should show formatted dates"
    exit 1
fi
echo "PASS: Results show formatted dates"

echo ""
echo "═══ All research page tests passed ═══"
