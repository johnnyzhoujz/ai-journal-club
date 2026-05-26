-- Persistent voice-digest memory schema additions.
-- Phase 1 is lexical-first and does not require pgvector.
-- If pgvector is already installed, this migration also adds nullable vector columns and indexes.

CREATE OR REPLACE FUNCTION set_memory_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION set_knowledge_chunk_search_fields()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.text_tsv := to_tsvector(
    'english',
    COALESCE(NEW.title, '') || ' ' ||
    COALESCE(NEW.author_name, '') || ' ' ||
    array_to_string(COALESCE(NEW.entity_labels, ARRAY[]::TEXT[]), ' ') || ' ' ||
    COALESCE(NEW.retrieval_text, NEW.text, '')
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION set_knowledge_note_search_fields()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.summary_tsv := to_tsvector(
    'english',
    COALESCE(NEW.title, '') || ' ' ||
    COALESCE(NEW.summary, '') || ' ' ||
    array_to_string(COALESCE(NEW.entity_labels, ARRAY[]::TEXT[]), ' ')
  );
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id                  SERIAL PRIMARY KEY,
  feed_item_id        INTEGER NOT NULL REFERENCES feed_items(id) ON DELETE CASCADE,
  chunk_index         INTEGER NOT NULL CHECK (chunk_index >= 0),
  source_type         TEXT NOT NULL CHECK (source_type IN ('tweet', 'podcast', 'newsletter', 'paper')),
  title               TEXT,
  author_name         TEXT NOT NULL,
  published_at        TIMESTAMPTZ,
  text                TEXT NOT NULL,
  retrieval_text      TEXT,
  memory_source_hash  TEXT,
  memory_source_kind  TEXT,
  token_count         INTEGER NOT NULL CHECK (token_count >= 0),
  text_tsv            TSVECTOR NOT NULL DEFAULT ''::tsvector,
  entity_labels       TEXT[] NOT NULL DEFAULT '{}',
  embedding_model     TEXT,
  embedding_updated_at TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_knowledge_chunks_feed_item_chunk UNIQUE (feed_item_id, chunk_index)
);

ALTER TABLE knowledge_chunks
  ADD COLUMN IF NOT EXISTS retrieval_text TEXT,
  ADD COLUMN IF NOT EXISTS memory_source_hash TEXT,
  ADD COLUMN IF NOT EXISTS memory_source_kind TEXT;

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_feed_item_id
  ON knowledge_chunks (feed_item_id);

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_source_type_published_at
  ON knowledge_chunks (source_type, published_at DESC);

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_published_at
  ON knowledge_chunks (published_at DESC);

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_text_tsv
  ON knowledge_chunks USING GIN (text_tsv);

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_entity_labels
  ON knowledge_chunks USING GIN (entity_labels);

DROP TRIGGER IF EXISTS trg_knowledge_chunks_updated_at ON knowledge_chunks;
CREATE TRIGGER trg_knowledge_chunks_updated_at
  BEFORE UPDATE ON knowledge_chunks
  FOR EACH ROW
  EXECUTE FUNCTION set_memory_updated_at();

DROP TRIGGER IF EXISTS trg_knowledge_chunks_search_fields ON knowledge_chunks;
CREATE TRIGGER trg_knowledge_chunks_search_fields
  BEFORE INSERT OR UPDATE ON knowledge_chunks
  FOR EACH ROW
  EXECUTE FUNCTION set_knowledge_chunk_search_fields();

CREATE TABLE IF NOT EXISTS knowledge_notes (
  id                    SERIAL PRIMARY KEY,
  scope                 TEXT NOT NULL CHECK (scope IN ('daily_digest', 'theme', 'builder', 'paper')),
  scope_key             TEXT NOT NULL,
  title                 TEXT NOT NULL,
  summary               TEXT NOT NULL,
  claims_json           JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_refs_json      JSONB NOT NULL DEFAULT '[]'::jsonb,
  entity_labels         TEXT[] NOT NULL DEFAULT '{}',
  effective_date        DATE NOT NULL,
  summary_tsv           TSVECTOR NOT NULL DEFAULT ''::tsvector,
  created_from_digest_id INTEGER REFERENCES digests(id) ON DELETE SET NULL,
  embedding_model       TEXT,
  embedding_updated_at  TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_knowledge_notes_scope_key_date UNIQUE (scope, scope_key, effective_date)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_notes_scope_effective_date
  ON knowledge_notes (scope, effective_date DESC);

CREATE INDEX IF NOT EXISTS idx_knowledge_notes_scope_key_effective_date
  ON knowledge_notes (scope, scope_key, effective_date DESC);

CREATE INDEX IF NOT EXISTS idx_knowledge_notes_created_from_digest_id
  ON knowledge_notes (created_from_digest_id);

CREATE INDEX IF NOT EXISTS idx_knowledge_notes_summary_tsv
  ON knowledge_notes USING GIN (summary_tsv);

CREATE INDEX IF NOT EXISTS idx_knowledge_notes_entity_labels
  ON knowledge_notes USING GIN (entity_labels);

DROP TRIGGER IF EXISTS trg_knowledge_notes_updated_at ON knowledge_notes;
CREATE TRIGGER trg_knowledge_notes_updated_at
  BEFORE UPDATE ON knowledge_notes
  FOR EACH ROW
  EXECUTE FUNCTION set_memory_updated_at();

DROP TRIGGER IF EXISTS trg_knowledge_notes_search_fields ON knowledge_notes;
CREATE TRIGGER trg_knowledge_notes_search_fields
  BEFORE INSERT OR UPDATE ON knowledge_notes
  FOR EACH ROW
  EXECUTE FUNCTION set_knowledge_note_search_fields();

CREATE TABLE IF NOT EXISTS knowledge_note_sources (
  id                SERIAL PRIMARY KEY,
  knowledge_note_id INTEGER NOT NULL REFERENCES knowledge_notes(id) ON DELETE CASCADE,
  feed_item_id      INTEGER NOT NULL REFERENCES feed_items(id) ON DELETE CASCADE,
  knowledge_chunk_id INTEGER REFERENCES knowledge_chunks(id) ON DELETE SET NULL,
  source_rank       INTEGER NOT NULL DEFAULT 0 CHECK (source_rank >= 0),
  citation_reason   TEXT NOT NULL DEFAULT 'supporting_evidence'
                      CHECK (citation_reason IN ('supporting_evidence', 'counterpoint', 'background')),
  excerpt           TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_knowledge_note_sources_note_id
  ON knowledge_note_sources (knowledge_note_id);

CREATE INDEX IF NOT EXISTS idx_knowledge_note_sources_feed_item_id
  ON knowledge_note_sources (feed_item_id);

CREATE INDEX IF NOT EXISTS idx_knowledge_note_sources_chunk_id
  ON knowledge_note_sources (knowledge_chunk_id);

CREATE TABLE IF NOT EXISTS user_memory (
  user_id               TEXT PRIMARY KEY,
  preferred_topics      TEXT[] NOT NULL DEFAULT '{}',
  tracked_builders      TEXT[] NOT NULL DEFAULT '{}',
  known_context         JSONB NOT NULL DEFAULT '[]'::jsonb,
  open_questions        JSONB NOT NULL DEFAULT '[]'::jsonb,
  briefing_preferences  JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_briefing_at      TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_user_memory_updated_at ON user_memory;
CREATE TRIGGER trg_user_memory_updated_at
  BEFORE UPDATE ON user_memory
  FOR EACH ROW
  EXECUTE FUNCTION set_memory_updated_at();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    ALTER TABLE knowledge_chunks
      ADD COLUMN IF NOT EXISTS embedding vector(1536);

    ALTER TABLE knowledge_notes
      ADD COLUMN IF NOT EXISTS embedding vector(1536);

    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_embedding
      ON knowledge_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)';

    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_knowledge_notes_embedding
      ON knowledge_notes USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50)';
  END IF;
END;
$$;
