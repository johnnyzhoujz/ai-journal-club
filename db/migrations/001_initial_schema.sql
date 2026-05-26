-- AI Journal Club database schema
-- Run against Neon Postgres via SQL Editor or DATABASE_URL_UNPOOLED

CREATE TABLE IF NOT EXISTS sources (
  id            SERIAL PRIMARY KEY,
  type          TEXT NOT NULL CHECK (type IN ('x_account', 'podcast', 'newsletter', 'papers')),
  name          TEXT NOT NULL,
  -- X account fields
  handle        TEXT,
  -- Podcast fields
  podcast_type  TEXT CHECK (podcast_type IN ('youtube_channel', 'youtube_playlist')),
  channel_handle TEXT,
  playlist_id   TEXT,
  url           TEXT,
  -- Newsletter fields
  feed_url      TEXT,
  -- Metadata
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  active        BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sources_handle ON sources (handle) WHERE type = 'x_account' AND active = TRUE;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sources_feed_url ON sources (feed_url) WHERE type = 'newsletter' AND active = TRUE;

CREATE TABLE IF NOT EXISTS feed_items (
  id            SERIAL PRIMARY KEY,
  source_type   TEXT NOT NULL CHECK (source_type IN ('tweet', 'podcast', 'newsletter', 'paper')),
  external_id   TEXT NOT NULL,            -- tweet ID, video ID, article URL, or arXiv ID
  source_id     INTEGER REFERENCES sources(id),
  title         TEXT,                     -- NULL for tweets
  content       TEXT NOT NULL,            -- tweet text, transcript, article body, or paper abstract
  url           TEXT NOT NULL,            -- direct link to original
  author_name   TEXT NOT NULL,
  author_handle TEXT,                     -- X handle (NULL for non-tweets)
  author_bio    TEXT,                     -- X bio (NULL for non-tweets)
  published_at  TIMESTAMPTZ,
  tweet_meta    JSONB,                    -- {likes, retweets, replies, isQuote, quotedTweetId}
  paper_meta    JSONB,                    -- {upvotes, numComments, githubRepo, githubStars, aiSummary, aiKeywords, authors[], providers?}
  full_text         TEXT,
  full_text_source  TEXT CHECK (full_text_source IS NULL OR full_text_source IN ('arxiv_html', 'hf_page')),
  corpus_tier       TEXT NOT NULL DEFAULT 'archive' CHECK (corpus_tier IN ('hot_set', 'core_canon', 'archive', 'ignored')),
  relevance_score   DOUBLE PRECISION,
  canon_score       DOUBLE PRECISION,
  hot_set_reason    TEXT,
  canon_reason      TEXT,
  archive_reason    TEXT,
  ignored_reason    TEXT,
  last_seen_at      TIMESTAMPTZ,
  last_scored_at    TIMESTAMPTZ,
  last_hydrated_at  TIMESTAMPTZ,
  tier_metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_external_id UNIQUE (source_type, external_id)
);

CREATE INDEX IF NOT EXISTS idx_feed_items_source_type ON feed_items (source_type);
CREATE INDEX IF NOT EXISTS idx_feed_items_fetched_at ON feed_items (fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_feed_items_published_at ON feed_items (published_at DESC);
CREATE INDEX IF NOT EXISTS idx_feed_items_content_search ON feed_items USING GIN (to_tsvector('english', content));
CREATE INDEX IF NOT EXISTS idx_feed_items_title_search ON feed_items USING GIN (to_tsvector('english', COALESCE(title, '')));
CREATE INDEX IF NOT EXISTS idx_feed_items_fts_v2 ON feed_items
  USING GIN (to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE(author_name, '') || ' ' || content));
CREATE INDEX IF NOT EXISTS idx_feed_items_paper_corpus_tier
  ON feed_items (corpus_tier, published_at DESC)
  WHERE source_type = 'paper';
CREATE INDEX IF NOT EXISTS idx_feed_items_paper_last_scored
  ON feed_items (last_scored_at DESC)
  WHERE source_type = 'paper';

CREATE TABLE IF NOT EXISTS digests (
  id               SERIAL PRIMARY KEY,
  content          TEXT NOT NULL,
  item_count       INTEGER NOT NULL DEFAULT 0,
  tweet_count      INTEGER NOT NULL DEFAULT 0,
  podcast_count    INTEGER NOT NULL DEFAULT 0,
  newsletter_count INTEGER NOT NULL DEFAULT 0,
  paper_count      INTEGER NOT NULL DEFAULT 0,
  source_item_ids  INTEGER[] NOT NULL DEFAULT '{}',
  model            TEXT,
  generated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS briefing_sessions (
  id                  TEXT PRIMARY KEY,
  digest_id           INTEGER NOT NULL REFERENCES digests(id),
  source_item_ids     INTEGER[] NOT NULL DEFAULT '{}',
  openai_call_id      TEXT,
  model               TEXT,
  prompt_hash         TEXT,
  prompt_budget_json  JSONB,
  tool_call_count     INTEGER NOT NULL DEFAULT 0,
  tool_call_max       INTEGER NOT NULL DEFAULT 100,
  search_archive_count INTEGER NOT NULL DEFAULT 0,
  search_archive_max  INTEGER NOT NULL DEFAULT 60,
  client_ip_hash      TEXT NOT NULL,
  recommended_end_at  TIMESTAMPTZ NOT NULL,
  expires_at          TIMESTAMPTZ NOT NULL,
  closed_at           TIMESTAMPTZ,
  hangup_attempted_at TIMESTAMPTZ,
  hangup_succeeded_at TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_briefing_sessions_expires ON briefing_sessions (expires_at)
  WHERE closed_at IS NULL;

CREATE TABLE IF NOT EXISTS briefing_handled_calls (
  briefing_session_id TEXT NOT NULL REFERENCES briefing_sessions(id),
  function_call_id    TEXT NOT NULL,
  tool_name           TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'completed', 'failed')),
  lease_expires_at    TIMESTAMPTZ,
  attempt_count       INTEGER NOT NULL DEFAULT 0,
  last_error          TEXT,
  result_payload      TEXT,
  request_arguments   JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (briefing_session_id, function_call_id)
);

CREATE TABLE IF NOT EXISTS briefing_trace_events (
  id                  BIGSERIAL PRIMARY KEY,
  briefing_session_id TEXT NOT NULL REFERENCES briefing_sessions(id) ON DELETE CASCADE,
  event_type          TEXT NOT NULL,
  source              TEXT NOT NULL CHECK (source IN ('client', 'server')),
  response_id         TEXT,
  item_id             TEXT,
  function_call_id    TEXT,
  tool_name           TEXT,
  role                TEXT CHECK (role IN ('assistant', 'user', 'tool')),
  text_excerpt        TEXT CHECK (char_length(text_excerpt) <= 500),
  arguments_json      JSONB,
  result_summary_json JSONB,
  latency_ms          INTEGER,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_briefing_trace_events_session_created
  ON briefing_trace_events (briefing_session_id, created_at, id);

CREATE INDEX IF NOT EXISTS idx_briefing_trace_events_type
  ON briefing_trace_events (event_type, created_at DESC);

CREATE TABLE IF NOT EXISTS briefing_trace_flags (
  id                  BIGSERIAL PRIMARY KEY,
  briefing_session_id TEXT NOT NULL REFERENCES briefing_sessions(id) ON DELETE CASCADE,
  rule_id             TEXT NOT NULL,
  severity            TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
  action              TEXT NOT NULL CHECK (action IN ('logged', 'nudged', 'normalized_args', 'blocked_tool')),
  event_id            BIGINT REFERENCES briefing_trace_events(id) ON DELETE SET NULL,
  tool_name           TEXT,
  original_json       JSONB,
  corrected_json      JSONB,
  details_json        JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_briefing_trace_flags_session_created
  ON briefing_trace_flags (briefing_session_id, created_at, id);

CREATE INDEX IF NOT EXISTS idx_briefing_trace_flags_rule
  ON briefing_trace_flags (rule_id, created_at DESC);

CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  ip_hash    TEXT NOT NULL,
  route_key  TEXT NOT NULL,
  bucket     TIMESTAMPTZ NOT NULL,
  count      INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (ip_hash, route_key, bucket)
);
