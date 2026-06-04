-- Runtime-editable settings (channel IDs + economy config).
-- Empty table = bot uses env-var defaults; rows here override them.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
