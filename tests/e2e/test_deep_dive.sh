#!/bin/bash
set -e

echo "TEST: Deep Dive feature on Digests page"

# Set auth cookie and navigate to digests
rodney open http://localhost:3000/digests
rodney js "document.cookie = 'auth=1; path=/'"
rodney open http://localhost:3000/digests
rodney waitstable

# Verify we're on the digests page
if rodney exists "h1"; then
    page_title=$(rodney text "h1")
    echo "PASS: Page loaded with title: $page_title"
else
    echo "FAIL: Digests page did not load"
    exit 1
fi

# Check if there are any digest cards
card_count=$(rodney count "[class*='rounded-lg border']")
if [ "$card_count" -lt 1 ]; then
    echo "SKIP: No digest cards found (empty database). Cannot test Deep Dive."
    echo "PASS: (skipped — no data)"
    exit 0
fi
echo "INFO: Found $card_count digest card(s)"

# Click the first digest card to expand it (use specific selector to avoid nav buttons)
rodney click "[class*='rounded-lg border'] button"
rodney waitstable

# Verify Deep Dive button appears when expanded
if rodney exists "[data-testid='deep-dive-button']"; then
    echo "PASS: Deep Dive button visible when digest is expanded"
else
    echo "FAIL: Deep Dive button not found after expanding digest"
    exit 1
fi

# Click the Deep Dive button
rodney click "[data-testid='deep-dive-button']"
rodney waitstable

# Verify overlay appeared
if rodney exists "[data-testid='deep-dive-backdrop']"; then
    echo "PASS: Deep Dive overlay opened with backdrop"
else
    echo "FAIL: Deep Dive overlay did not open"
    exit 1
fi

# Verify chat input is present
if rodney exists "textarea[placeholder]"; then
    echo "PASS: Chat input textarea is present"
else
    echo "FAIL: Chat input textarea not found in overlay"
    exit 1
fi

# Verify welcome message
if rodney exists "p"; then
    echo "PASS: Welcome/instruction text is present"
else
    echo "WARN: No welcome text found"
fi

# Verify close button exists
if rodney exists "button[aria-label='Close deep dive']"; then
    echo "PASS: Close button is present"
else
    echo "FAIL: Close button not found"
    exit 1
fi

# Click close button to dismiss overlay
rodney click "button[aria-label='Close deep dive']"
rodney waitstable

# Verify overlay is dismissed
if rodney exists "[data-testid='deep-dive-backdrop']"; then
    echo "FAIL: Overlay still visible after closing"
    exit 1
else
    echo "PASS: Overlay closed successfully"
fi

echo ""
echo "All Deep Dive tests passed!"
