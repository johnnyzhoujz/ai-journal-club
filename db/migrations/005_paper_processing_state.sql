-- Durable state for resumable paper hydration and enrichment workers.
-- Safe to run more than once.

CREATE TABLE IF NOT EXISTS paper_processing_state (
  feed_item_id INTEGER PRIMARY KEY REFERENCES feed_items(id) ON DELETE CASCADE,

  source_hash TEXT,
  evidence_quality TEXT NOT NULL DEFAULT 'unknown'
    CHECK (evidence_quality IN (
      'unknown',
      'full_text',
      'truncated_full_text',
      'abstract_only',
      'metadata_only'
    )),

  full_text_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (full_text_status IN (
      'pending',
      'running',
      'succeeded',
      'unavailable',
      'failed',
      'dead',
      'stale'
    )),
  deterministic_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (deterministic_status IN (
      'pending',
      'running',
      'succeeded',
      'failed',
      'dead',
      'stale'
    )),
  semantic_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (semantic_status IN (
      'pending',
      'running',
      'succeeded',
      'failed',
      'dead',
      'stale',
      'skipped'
    )),

  digest_ready BOOLEAN NOT NULL DEFAULT FALSE,

  deterministic_attempt_count INTEGER NOT NULL DEFAULT 0,
  semantic_attempt_count INTEGER NOT NULL DEFAULT 0,
  deterministic_next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  semantic_next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  lease_token TEXT,
  lease_expires_at TIMESTAMPTZ,

  deterministic_last_error TEXT,
  semantic_last_error TEXT,
  last_started_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_failed_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO paper_processing_state (
  feed_item_id,
  source_hash,
  full_text_status,
  deterministic_status,
  semantic_status,
  digest_ready,
  deterministic_next_run_at,
  semantic_next_run_at
)
SELECT
  fi.id,
  NULL,
  CASE
    WHEN NULLIF(BTRIM(fi.full_text), '') IS NOT NULL THEN 'succeeded'
    ELSE 'pending'
  END,
  'pending',
  'pending',
  FALSE,
  NOW(),
  NOW()
FROM feed_items fi
WHERE fi.source_type = 'paper'
  AND COALESCE(fi.corpus_tier, 'archive') <> 'ignored'
  AND COALESCE(fi.tier_metadata_json->>'ignored', 'false') <> 'true'
  AND COALESCE(fi.tier_metadata_json->>'manualTier', '') NOT IN ('archive', 'core_canon', 'ignored')
  AND (
    COALESCE(fi.corpus_tier, 'archive') = 'hot_set'
    OR COALESCE(fi.tier_metadata_json->>'pinned', 'false') = 'true'
    OR COALESCE(fi.tier_metadata_json->>'manualTier', '') = 'hot_set'
    OR (
      COALESCE(fi.tier_metadata_json->'retention'->>'pendingTier', '') = 'hot_set'
      AND CASE
        WHEN COALESCE(fi.tier_metadata_json->'retention'->>'intakeDefaultTier', '') <> 'hot_set'
        THEN TRUE
        WHEN COALESCE(
          NULLIF(fi.tier_metadata_json->'retention'->>'selectedAt', ''),
          NULLIF(fi.tier_metadata_json->'retention'->>'pendingReviewStartedAt', '')
        ) IS NULL
        THEN FALSE
        WHEN COALESCE(
          NULLIF(fi.tier_metadata_json->'retention'->>'pendingReviewStartedAt', '')::timestamptz,
          NULLIF(fi.tier_metadata_json->'retention'->>'selectedAt', '')::timestamptz
        ) >
          COALESCE(
            NULLIF(fi.tier_metadata_json->'retention'->>'selectedAt', '')::timestamptz,
            NULLIF(fi.tier_metadata_json->'retention'->>'pendingReviewStartedAt', '')::timestamptz
          ) + (
            CASE
              WHEN COALESCE(fi.tier_metadata_json->'retention'->>'graceDays', '') ~ '^[0-9]+$'
              THEN (fi.tier_metadata_json->'retention'->>'graceDays')::integer
              ELSE 14
            END * INTERVAL '1 day'
          )
        THEN TRUE
        ELSE NOW() BETWEEN
          COALESCE(
            NULLIF(fi.tier_metadata_json->'retention'->>'selectedAt', '')::timestamptz,
            NULLIF(fi.tier_metadata_json->'retention'->>'pendingReviewStartedAt', '')::timestamptz
          ) AND
          COALESCE(
            NULLIF(fi.tier_metadata_json->'retention'->>'selectedAt', '')::timestamptz,
            NULLIF(fi.tier_metadata_json->'retention'->>'pendingReviewStartedAt', '')::timestamptz
          ) + (
            CASE
              WHEN COALESCE(fi.tier_metadata_json->'retention'->>'graceDays', '') ~ '^[0-9]+$'
              THEN (fi.tier_metadata_json->'retention'->>'graceDays')::integer
              ELSE 14
            END * INTERVAL '1 day'
          )
      END
    )
  )
ON CONFLICT (feed_item_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_paper_processing_deterministic_queue
  ON paper_processing_state (
    deterministic_status,
    deterministic_next_run_at,
    lease_expires_at
  );

CREATE INDEX IF NOT EXISTS idx_paper_processing_semantic_queue
  ON paper_processing_state (
    semantic_status,
    semantic_next_run_at,
    lease_expires_at
  );

CREATE INDEX IF NOT EXISTS idx_paper_processing_digest_ready
  ON paper_processing_state (digest_ready)
  WHERE digest_ready = TRUE;

CREATE OR REPLACE FUNCTION set_paper_processing_state_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_paper_processing_state_updated_at
  ON paper_processing_state;
CREATE TRIGGER trg_paper_processing_state_updated_at
  BEFORE UPDATE ON paper_processing_state
  FOR EACH ROW
  EXECUTE FUNCTION set_paper_processing_state_updated_at();
