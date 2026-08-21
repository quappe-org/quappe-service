CREATE TABLE IF NOT EXISTS theses (
  id                  TEXT PRIMARY KEY,
  title               TEXT NOT NULL,
  description         TEXT NOT NULL,
  description_simple  TEXT,
  description_dense   TEXT,
  categories_json     TEXT NOT NULL DEFAULT '[]',
  hashtags_json       TEXT NOT NULL DEFAULT '[]',
  related_ids_json    TEXT NOT NULL DEFAULT '[]',
  archived            INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
  lifecycle_state     TEXT NOT NULL,
  lifecycle_since     TEXT NOT NULL,
  lifecycle_quality   REAL NOT NULL DEFAULT 0,
  lang                TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  author_id           TEXT NOT NULL,
  location            TEXT,
  external_ref        TEXT
);
CREATE INDEX IF NOT EXISTS idx_theses_lifecycle_state ON theses(lifecycle_state);
CREATE INDEX IF NOT EXISTS idx_theses_author         ON theses(author_id);
CREATE INDEX IF NOT EXISTS idx_theses_lang_missing   ON theses(lang) WHERE lang IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_theses_external_ref ON theses(external_ref) WHERE external_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS arguments (
  id              TEXT PRIMARY KEY,
  thesis_id       TEXT NOT NULL REFERENCES theses(id) ON DELETE CASCADE,
  content         TEXT NOT NULL,
  attributes_json TEXT NOT NULL DEFAULT '[]',
  categories_json TEXT,
  hashtags_json   TEXT,
  forked_from_id  TEXT REFERENCES arguments(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  author_id       TEXT NOT NULL,
  location        TEXT
);
CREATE INDEX IF NOT EXISTS idx_arguments_thesis      ON arguments(thesis_id);
CREATE INDEX IF NOT EXISTS idx_arguments_author      ON arguments(author_id);
CREATE INDEX IF NOT EXISTS idx_arguments_forked_from ON arguments(forked_from_id);

CREATE TABLE IF NOT EXISTS votes (
  target_type TEXT NOT NULL CHECK (target_type IN ('thesis','argument')),
  target_id   TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  vote_type   TEXT NOT NULL CHECK (vote_type IN ('support','reject','neutral')),
  weight      INTEGER NOT NULL DEFAULT 1 CHECK (weight >= 1 AND weight <= 5),
  cast_at     TEXT NOT NULL,
  PRIMARY KEY (target_type, target_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_votes_target ON votes(target_id, target_type);
CREATE INDEX IF NOT EXISTS idx_votes_user   ON votes(user_id, cast_at);

CREATE TABLE IF NOT EXISTS embeddings (
  target_type TEXT NOT NULL CHECK (target_type IN ('thesis','argument')),
  target_id   TEXT NOT NULL,
  vec         BLOB NOT NULL,
  dim         INTEGER NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (target_type, target_id)
);
CREATE INDEX IF NOT EXISTS idx_embeddings_target ON embeddings(target_id, target_type);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Per-user "this update event was read" markers. event_key is a deterministic
-- hash of the event (kind + ids + timestamp) computed by the updates endpoint.
CREATE TABLE IF NOT EXISTS read_updates (
  user_id   TEXT NOT NULL,
  event_key TEXT NOT NULL,
  read_at   TEXT NOT NULL,
  PRIMARY KEY (user_id, event_key)
);
CREATE INDEX IF NOT EXISTS idx_read_updates_user ON read_updates(user_id);
