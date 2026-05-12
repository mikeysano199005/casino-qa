-- Per-user preset override — when set, takes priority over game/amount presets
ALTER TABLE users ADD COLUMN IF NOT EXISTS user_preset TEXT;
