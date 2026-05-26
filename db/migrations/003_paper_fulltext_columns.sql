-- Adds full-text storage columns to feed_items.

ALTER TABLE feed_items
  ADD COLUMN IF NOT EXISTS full_text TEXT,
  ADD COLUMN IF NOT EXISTS full_text_source TEXT;

ALTER TABLE feed_items
  DROP CONSTRAINT IF EXISTS chk_feed_items_full_text_source;

ALTER TABLE feed_items
  ADD CONSTRAINT chk_feed_items_full_text_source
  CHECK (full_text_source IS NULL OR full_text_source IN ('arxiv_html', 'hf_page'));
