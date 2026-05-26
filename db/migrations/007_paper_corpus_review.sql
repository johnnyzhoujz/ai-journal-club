CREATE TABLE IF NOT EXISTS paper_corpus_review_runs (
  id BIGSERIAL PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  mode TEXT NOT NULL CHECK (mode IN ('saved_review', 'execute_tier_updates')),
  status TEXT NOT NULL DEFAULT 'started' CHECK (status IN ('started', 'completed', 'failed')),
  hot_set_target INTEGER,
  hot_set_cap INTEGER,
  core_canon_target INTEGER,
  archive_lookback_days INTEGER NOT NULL,
  summary_json JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS paper_corpus_review_items (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES paper_corpus_review_runs(id) ON DELETE CASCADE,
  feed_item_id BIGINT NOT NULL REFERENCES feed_items(id) ON DELETE CASCADE,
  previous_tier TEXT NOT NULL CHECK (previous_tier IN ('hot_set', 'core_canon', 'archive', 'ignored')),
  recommended_tier TEXT NOT NULL CHECK (recommended_tier IN ('hot_set', 'core_canon', 'archive', 'ignored')),
  applied_tier TEXT NOT NULL CHECK (applied_tier IN ('hot_set', 'core_canon', 'archive', 'ignored')),
  action TEXT NOT NULL CHECK (action IN ('promote', 'demote', 'keep')),
  age_days INTEGER,
  score DOUBLE PRECISION NOT NULL,
  freshness_score DOUBLE PRECISION NOT NULL,
  popularity_score DOUBLE PRECISION NOT NULL,
  popularity_growth_score DOUBLE PRECISION NOT NULL,
  hf_upvotes INTEGER NOT NULL DEFAULT 0,
  hf_comments INTEGER NOT NULL DEFAULT 0,
  github_stars INTEGER NOT NULL DEFAULT 0,
  github_repo TEXT,
  previous_hf_upvotes INTEGER,
  previous_hf_comments INTEGER,
  previous_github_stars INTEGER,
  reasons_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  manual_override BOOLEAN NOT NULL DEFAULT FALSE,
  manual_override_type TEXT,
  manual_override_detail TEXT,
  popularity_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  popularity_growth_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  storage_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_paper_corpus_review_items_run_id
  ON paper_corpus_review_items (run_id, feed_item_id);

CREATE INDEX IF NOT EXISTS idx_paper_corpus_review_items_feed_item_id
  ON paper_corpus_review_items (feed_item_id, created_at DESC);
