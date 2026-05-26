#!/bin/bash
set -e

echo "TEST: Sources page form fields per tab"

rodney open http://localhost:3000/sources
sleep 2
rodney waitstable

# --- X Accounts tab (active by default) ---
echo ""
echo "Checking X Accounts tab..."

# Should have Name and Handle fields
if ! rodney exists "#x_account-name" 2>/dev/null; then
    echo "FAIL: Name field missing on X Accounts tab"
    exit 1
fi
echo "PASS: Name field present on X Accounts tab"

if ! rodney exists "#x-handle" 2>/dev/null; then
    echo "FAIL: Handle field missing on X Accounts tab"
    exit 1
fi
echo "PASS: Handle field present on X Accounts tab"

# Should have Add Source button
if ! rodney exists "button[type=submit]" 2>/dev/null; then
    echo "FAIL: Add Source button missing"
    exit 1
fi
add_text=$(rodney text "button[type=submit]")
if [ "$add_text" != "Add Source" ]; then
    echo "FAIL: Expected 'Add Source' button, got '$add_text'"
    exit 1
fi
echo "PASS: Add Source button present"

# --- Podcasts tab ---
echo ""
echo "Checking Podcasts tab..."
rodney click "[role=tab]:nth-child(2)"
rodney waitstable

if ! rodney exists "#podcast-name" 2>/dev/null; then
    echo "FAIL: Name field missing on Podcasts tab"
    exit 1
fi
echo "PASS: Name field present on Podcasts tab"

if ! rodney exists "#podcast-type" 2>/dev/null; then
    echo "FAIL: Type selector missing on Podcasts tab"
    exit 1
fi
echo "PASS: Type selector present on Podcasts tab"

if ! rodney exists "#podcast-url" 2>/dev/null; then
    echo "FAIL: URL field missing on Podcasts tab"
    exit 1
fi
echo "PASS: URL field present on Podcasts tab"

if ! rodney exists "#channel-handle" 2>/dev/null; then
    echo "FAIL: Channel Handle field missing on Podcasts tab"
    exit 1
fi
echo "PASS: Channel Handle field present on Podcasts tab"

# Select youtube_playlist and check playlist_id appears
rodney select "#podcast-type" "youtube_playlist"
rodney waitstable

if ! rodney exists "#playlist-id" 2>/dev/null; then
    echo "FAIL: Playlist ID field missing after selecting youtube_playlist"
    exit 1
fi
echo "PASS: Playlist ID field appears when youtube_playlist selected"

# channel-handle should be gone
if rodney exists "#channel-handle" 2>/dev/null; then
    echo "FAIL: Channel Handle should be hidden for youtube_playlist"
    exit 1
fi
echo "PASS: Channel Handle hidden for youtube_playlist"

# --- Newsletters tab ---
echo ""
echo "Checking Newsletters tab..."
rodney click "[role=tab]:nth-child(3)"
rodney waitstable

if ! rodney exists "#newsletter-name" 2>/dev/null; then
    echo "FAIL: Name field missing on Newsletters tab"
    exit 1
fi
echo "PASS: Name field present on Newsletters tab"

if ! rodney exists "#newsletter-url" 2>/dev/null; then
    echo "FAIL: URL field missing on Newsletters tab"
    exit 1
fi
echo "PASS: URL field present on Newsletters tab"

if ! rodney exists "#feed-url" 2>/dev/null; then
    echo "FAIL: Feed URL field missing on Newsletters tab"
    exit 1
fi
echo "PASS: Feed URL field present on Newsletters tab"

# Check Detect Feed button exists and is disabled (no URL entered)
detect_text=$(rodney js "Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Detect Feed'))?.textContent || 'NOT FOUND'")
if [[ "$detect_text" != *"Detect Feed"* ]]; then
    echo "FAIL: Expected 'Detect Feed' button, got '$detect_text'"
    exit 1
fi
echo "PASS: Detect Feed button present on Newsletters tab"

# Check Detect Feed is disabled when URL is empty
is_disabled=$(rodney js "Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Detect Feed'))?.disabled")
if [ "$is_disabled" != "true" ]; then
    echo "FAIL: Detect Feed should be disabled when URL is empty"
    exit 1
fi
echo "PASS: Detect Feed button disabled when URL is empty"

# --- Papers tab ---
echo ""
echo "Checking Papers tab..."
rodney click "[role=tab]:nth-child(4)"
rodney waitstable

# Should have a toggle switch
if ! rodney exists "[role=switch]" 2>/dev/null; then
    echo "FAIL: Toggle switch missing on Papers tab"
    exit 1
fi
echo "PASS: Toggle switch present on Papers tab"

# Should NOT have an Add Source button
if rodney exists "button[type=submit]" 2>/dev/null; then
    echo "FAIL: Add Source button should not be on Papers tab"
    exit 1
fi
echo "PASS: No Add Source button on Papers tab"

# Should show description text
papers_text=$(rodney js "document.querySelector('label[for=papers-toggle]')?.textContent || ''")
if [[ "$papers_text" != *"Hugging Face"* ]]; then
    echo "FAIL: Expected Hugging Face Daily Papers label, got '$papers_text'"
    exit 1
fi
echo "PASS: Papers description text present"

echo ""
echo "All form field tests passed"
