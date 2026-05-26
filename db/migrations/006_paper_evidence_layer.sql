-- Fast paper evidence layer v1.

CREATE OR REPLACE FUNCTION set_paper_evidence_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION set_paper_section_search_fields()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.text_tsv := to_tsvector(
    'english',
    array_to_string(COALESCE(NEW.section_path, ARRAY[]::TEXT[]), ' ') || ' ' ||
    COALESCE(NEW.text, '')
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION set_paper_evidence_span_search_fields()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.text_tsv := to_tsvector(
    'english',
    COALESCE(NEW.normalized_text, NEW.text, '')
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION set_paper_evidence_card_search_fields()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.text_tsv := to_tsvector(
    'english',
    COALESCE(NEW.claim, '') || ' ' ||
    COALESCE(NEW.claim_type, '') || ' ' ||
    array_to_string(COALESCE(NEW.section_path, ARRAY[]::TEXT[]), ' ') || ' ' ||
    array_to_string(COALESCE(NEW.entities, ARRAY[]::TEXT[]), ' ') || ' ' ||
    array_to_string(COALESCE(NEW.methods, ARRAY[]::TEXT[]), ' ') || ' ' ||
    array_to_string(COALESCE(NEW.datasets, ARRAY[]::TEXT[]), ' ') || ' ' ||
    array_to_string(COALESCE(NEW.metrics, ARRAY[]::TEXT[]), ' ') || ' ' ||
    array_to_string(COALESCE(NEW.numbers, ARRAY[]::TEXT[]), ' ') || ' ' ||
    array_to_string(COALESCE(NEW.aliases, ARRAY[]::TEXT[]), ' ')
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION set_paper_reader_profile_search_fields()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.text_tsv := to_tsvector(
    'english',
    COALESCE(NEW.profile_text, '') || ' ' ||
    array_to_string(COALESCE(NEW.title_aliases, ARRAY[]::TEXT[]), ' ') || ' ' ||
    array_to_string(COALESCE(NEW.keyphrases, ARRAY[]::TEXT[]), ' ') || ' ' ||
    array_to_string(COALESCE(NEW.identity_anchors, ARRAY[]::TEXT[]), ' ')
  );
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS paper_sections (
  id              SERIAL PRIMARY KEY,
  stable_key      TEXT NOT NULL UNIQUE,
  feed_item_id    INTEGER NOT NULL REFERENCES feed_items(id) ON DELETE CASCADE,
  section_index   INTEGER NOT NULL CHECK (section_index >= 0),
  section_path    TEXT[] NOT NULL DEFAULT '{}',
  section_type    TEXT NOT NULL CHECK (
    section_type IN (
      'title',
      'abstract',
      'intro',
      'method',
      'result',
      'discussion',
      'limitation',
      'appendix',
      'references',
      'unknown'
    )
  ),
  text            TEXT NOT NULL,
  text_tsv        TSVECTOR NOT NULL DEFAULT ''::tsvector,
  page_start      INTEGER,
  page_end        INTEGER,
  source_hash     TEXT NOT NULL,
  parser_version  TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(feed_item_id, source_hash, section_index)
);

CREATE TABLE IF NOT EXISTS paper_evidence_spans (
  id                SERIAL PRIMARY KEY,
  stable_key        TEXT NOT NULL UNIQUE,
  feed_item_id      INTEGER NOT NULL REFERENCES feed_items(id) ON DELETE CASCADE,
  section_id        INTEGER NOT NULL REFERENCES paper_sections(id) ON DELETE CASCADE,
  span_index        INTEGER NOT NULL CHECK (span_index >= 0),
  span_type         TEXT NOT NULL CHECK (
    span_type IN (
      'paragraph',
      'sentence',
      'table_row',
      'figure_caption',
      'equation_context'
    )
  ),
  origin            TEXT NOT NULL DEFAULT 'parser_sentence' CHECK (
    origin IN ('llm_proposition', 'parser_sentence')
  ),
  text              TEXT NOT NULL,
  normalized_text   TEXT NOT NULL,
  text_tsv          TSVECTOR NOT NULL DEFAULT ''::tsvector,
  page              INTEGER,
  bbox_json         JSONB,
  backing_chunk_id  INTEGER REFERENCES knowledge_chunks(id) ON DELETE SET NULL,
  source_hash       TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(feed_item_id, source_hash, span_index)
);

CREATE TABLE IF NOT EXISTS paper_evidence_cards (
  id                       SERIAL PRIMARY KEY,
  stable_key               TEXT NOT NULL UNIQUE,
  feed_item_id             INTEGER NOT NULL REFERENCES feed_items(id) ON DELETE CASCADE,
  primary_support_span_id  INTEGER NOT NULL REFERENCES paper_evidence_spans(id) ON DELETE CASCADE,
  claim                    TEXT NOT NULL,
  claim_type               TEXT NOT NULL CHECK (
    claim_type IN (
      'contribution',
      'method',
      'dataset',
      'benchmark',
      'metric',
      'result',
      'limitation',
      'comparison',
      'implementation',
      'unknown'
    )
  ),
  support_span_ids         INTEGER[] NOT NULL DEFAULT '{}',
  section_path             TEXT[] NOT NULL DEFAULT '{}',
  entities                 TEXT[] NOT NULL DEFAULT '{}',
  methods                  TEXT[] NOT NULL DEFAULT '{}',
  datasets                 TEXT[] NOT NULL DEFAULT '{}',
  metrics                  TEXT[] NOT NULL DEFAULT '{}',
  numbers                  TEXT[] NOT NULL DEFAULT '{}',
  aliases                  TEXT[] NOT NULL DEFAULT '{}',
  confidence               DOUBLE PRECISION NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  verifier_status          TEXT NOT NULL CHECK (
    verifier_status IN ('supports', 'paper_related_only', 'unsupported')
  ),
  extractor_version        TEXT NOT NULL,
  source_hash              TEXT NOT NULL,
  text_tsv                 TSVECTOR NOT NULL DEFAULT ''::tsvector,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(feed_item_id, source_hash, primary_support_span_id, claim_type)
);

CREATE TABLE IF NOT EXISTS paper_reader_profiles (
  id                SERIAL PRIMARY KEY,
  stable_key        TEXT NOT NULL UNIQUE,
  feed_item_id      INTEGER NOT NULL REFERENCES feed_items(id) ON DELETE CASCADE,
  source_hash       TEXT NOT NULL,
  profile_text      TEXT NOT NULL,
  title_aliases     TEXT[] NOT NULL DEFAULT '{}',
  keyphrases        TEXT[] NOT NULL DEFAULT '{}',
  identity_anchors  TEXT[] NOT NULL DEFAULT '{}',
  parser_version    TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  text_tsv          TSVECTOR NOT NULL DEFAULT ''::tsvector,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(feed_item_id, source_hash)
);

DO $$
BEGIN
  ALTER TABLE paper_reader_profiles
    ADD COLUMN IF NOT EXISTS profile_text TEXT,
    ADD COLUMN IF NOT EXISTS parser_version TEXT,
    ADD COLUMN IF NOT EXISTS extractor_version TEXT;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'paper_reader_profiles'
      AND column_name = 'profile_json'
  ) THEN
    EXECUTE $profile_json_backfill$
      UPDATE paper_reader_profiles
      SET profile_text = COALESCE(
            NULLIF(profile_text, ''),
            NULLIF(profile_json->>'profile_text', ''),
            NULLIF(profile_json->>'summary', ''),
            NULLIF(profile_json::text, '{}')
          )
      WHERE profile_text IS NULL
         OR profile_text = ''
    $profile_json_backfill$;
  END IF;

  UPDATE paper_reader_profiles
  SET profile_text = COALESCE(
        NULLIF(profile_text, ''),
        NULLIF(array_to_string(COALESCE(title_aliases, ARRAY[]::TEXT[]), ' '), ''),
        stable_key
      )
  WHERE profile_text IS NULL
     OR profile_text = '';

  UPDATE paper_reader_profiles
  SET parser_version = COALESCE(
        parser_version,
        'paper-evidence-layer-parser:v1'
      ),
      extractor_version = COALESCE(
        extractor_version,
        'paper-evidence-layer-extractor:v2'
      )
  WHERE parser_version IS NULL
     OR extractor_version IS NULL;

  ALTER TABLE paper_reader_profiles
    ALTER COLUMN profile_text SET NOT NULL,
    ALTER COLUMN parser_version SET NOT NULL,
    ALTER COLUMN extractor_version SET NOT NULL;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'paper_reader_profiles'
      AND column_name = 'reader_version'
  ) THEN
    ALTER TABLE paper_reader_profiles
      ALTER COLUMN reader_version SET DEFAULT 'paper-reader-profile:v2';
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_paper_sections_feed_item
  ON paper_sections(feed_item_id);

CREATE INDEX IF NOT EXISTS idx_paper_sections_feed_item_source
  ON paper_sections(feed_item_id, source_hash);

CREATE INDEX IF NOT EXISTS idx_paper_sections_tsv
  ON paper_sections USING GIN(text_tsv);

CREATE INDEX IF NOT EXISTS idx_paper_evidence_spans_feed_item
  ON paper_evidence_spans(feed_item_id);

CREATE INDEX IF NOT EXISTS idx_paper_evidence_spans_feed_item_source
  ON paper_evidence_spans(feed_item_id, source_hash);

CREATE INDEX IF NOT EXISTS idx_paper_evidence_spans_section
  ON paper_evidence_spans(section_id);

CREATE INDEX IF NOT EXISTS idx_paper_evidence_spans_backing_chunk
  ON paper_evidence_spans(backing_chunk_id);

CREATE INDEX IF NOT EXISTS idx_paper_evidence_spans_tsv
  ON paper_evidence_spans USING GIN(text_tsv);

CREATE INDEX IF NOT EXISTS idx_paper_evidence_cards_feed_item
  ON paper_evidence_cards(feed_item_id);

CREATE INDEX IF NOT EXISTS idx_paper_evidence_cards_primary_span
  ON paper_evidence_cards(primary_support_span_id);

CREATE INDEX IF NOT EXISTS idx_paper_evidence_cards_tsv
  ON paper_evidence_cards USING GIN(text_tsv);

CREATE INDEX IF NOT EXISTS idx_paper_evidence_cards_entities
  ON paper_evidence_cards USING GIN(entities);

CREATE INDEX IF NOT EXISTS idx_paper_evidence_cards_methods
  ON paper_evidence_cards USING GIN(methods);

CREATE INDEX IF NOT EXISTS idx_paper_evidence_cards_datasets
  ON paper_evidence_cards USING GIN(datasets);

CREATE INDEX IF NOT EXISTS idx_paper_evidence_cards_metrics
  ON paper_evidence_cards USING GIN(metrics);

CREATE INDEX IF NOT EXISTS idx_paper_evidence_cards_numbers
  ON paper_evidence_cards USING GIN(numbers);

CREATE INDEX IF NOT EXISTS idx_paper_reader_profiles_feed_item
  ON paper_reader_profiles(feed_item_id);

CREATE INDEX IF NOT EXISTS idx_paper_reader_profiles_feed_item_source
  ON paper_reader_profiles(feed_item_id, source_hash);

CREATE INDEX IF NOT EXISTS idx_paper_reader_profiles_tsv
  ON paper_reader_profiles USING GIN(text_tsv);

CREATE INDEX IF NOT EXISTS idx_paper_reader_profiles_keyphrases
  ON paper_reader_profiles USING GIN(keyphrases);

CREATE INDEX IF NOT EXISTS idx_paper_reader_profiles_identity_anchors
  ON paper_reader_profiles USING GIN(identity_anchors);

DROP TRIGGER IF EXISTS trg_paper_sections_updated_at ON paper_sections;
CREATE TRIGGER trg_paper_sections_updated_at
  BEFORE UPDATE ON paper_sections
  FOR EACH ROW
  EXECUTE FUNCTION set_paper_evidence_updated_at();

DROP TRIGGER IF EXISTS trg_paper_sections_search_fields ON paper_sections;
CREATE TRIGGER trg_paper_sections_search_fields
  BEFORE INSERT OR UPDATE ON paper_sections
  FOR EACH ROW
  EXECUTE FUNCTION set_paper_section_search_fields();

DROP TRIGGER IF EXISTS trg_paper_evidence_spans_updated_at ON paper_evidence_spans;
CREATE TRIGGER trg_paper_evidence_spans_updated_at
  BEFORE UPDATE ON paper_evidence_spans
  FOR EACH ROW
  EXECUTE FUNCTION set_paper_evidence_updated_at();

DROP TRIGGER IF EXISTS trg_paper_evidence_spans_search_fields ON paper_evidence_spans;
CREATE TRIGGER trg_paper_evidence_spans_search_fields
  BEFORE INSERT OR UPDATE ON paper_evidence_spans
  FOR EACH ROW
  EXECUTE FUNCTION set_paper_evidence_span_search_fields();

DROP TRIGGER IF EXISTS trg_paper_evidence_cards_updated_at ON paper_evidence_cards;
CREATE TRIGGER trg_paper_evidence_cards_updated_at
  BEFORE UPDATE ON paper_evidence_cards
  FOR EACH ROW
  EXECUTE FUNCTION set_paper_evidence_updated_at();

DROP TRIGGER IF EXISTS trg_paper_evidence_cards_search_fields ON paper_evidence_cards;
CREATE TRIGGER trg_paper_evidence_cards_search_fields
  BEFORE INSERT OR UPDATE ON paper_evidence_cards
  FOR EACH ROW
  EXECUTE FUNCTION set_paper_evidence_card_search_fields();

DROP TRIGGER IF EXISTS trg_paper_reader_profiles_updated_at ON paper_reader_profiles;
CREATE TRIGGER trg_paper_reader_profiles_updated_at
  BEFORE UPDATE ON paper_reader_profiles
  FOR EACH ROW
  EXECUTE FUNCTION set_paper_evidence_updated_at();

DROP TRIGGER IF EXISTS trg_paper_reader_profiles_search_fields ON paper_reader_profiles;
CREATE TRIGGER trg_paper_reader_profiles_search_fields
  BEFORE INSERT OR UPDATE ON paper_reader_profiles
  FOR EACH ROW
  EXECUTE FUNCTION set_paper_reader_profile_search_fields();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'paper_evidence_spans'
      AND column_name = 'origin'
  ) THEN
    ALTER TABLE paper_evidence_spans
      ADD COLUMN origin TEXT;
  END IF;

  UPDATE paper_evidence_spans
  SET origin = CASE
    WHEN stable_key LIKE 'paper-llm-parser-span:%' THEN 'parser_sentence'
    WHEN stable_key LIKE 'paper-llm-span:%' THEN 'llm_proposition'
    WHEN stable_key LIKE 'paper-span:%' THEN 'parser_sentence'
    ELSE 'parser_sentence'
  END
  WHERE origin IS NULL
     OR origin NOT IN ('llm_proposition', 'parser_sentence');

  ALTER TABLE paper_evidence_spans
    ALTER COLUMN origin SET DEFAULT 'parser_sentence';
  ALTER TABLE paper_evidence_spans
    ALTER COLUMN origin SET NOT NULL;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_name = 'paper_evidence_spans'
      AND constraint_name = 'paper_evidence_spans_origin_check'
  ) THEN
    ALTER TABLE paper_evidence_spans
      ADD CONSTRAINT paper_evidence_spans_origin_check
      CHECK (origin IN ('llm_proposition', 'parser_sentence'));
  END IF;
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    EXECUTE 'ALTER TABLE paper_evidence_spans
      ADD COLUMN IF NOT EXISTS embedding vector(1536),
      ADD COLUMN IF NOT EXISTS embedding_model TEXT,
      ADD COLUMN IF NOT EXISTS embedding_updated_at TIMESTAMPTZ';

    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_paper_evidence_spans_embedding
      ON paper_evidence_spans USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50)';
  END IF;
END;
$$;
