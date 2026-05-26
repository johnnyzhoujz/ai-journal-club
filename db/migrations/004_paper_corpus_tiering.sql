ALTER TABLE feed_items
  ADD COLUMN IF NOT EXISTS corpus_tier TEXT NOT NULL DEFAULT 'archive' CHECK (corpus_tier IN ('hot_set', 'core_canon', 'archive', 'ignored')),
  ADD COLUMN IF NOT EXISTS relevance_score DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS canon_score DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS hot_set_reason TEXT,
  ADD COLUMN IF NOT EXISTS canon_reason TEXT,
  ADD COLUMN IF NOT EXISTS archive_reason TEXT,
  ADD COLUMN IF NOT EXISTS ignored_reason TEXT,
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_scored_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_hydrated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS tier_metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_feed_items_paper_corpus_tier
  ON feed_items (corpus_tier, published_at DESC)
  WHERE source_type = 'paper';

CREATE INDEX IF NOT EXISTS idx_feed_items_paper_last_scored
  ON feed_items (last_scored_at DESC)
  WHERE source_type = 'paper';
