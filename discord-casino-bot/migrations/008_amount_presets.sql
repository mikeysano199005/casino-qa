CREATE TABLE IF NOT EXISTS amount_preset_config (
  id          INTEGER     PRIMARY KEY DEFAULT 1,
  enabled     BOOLEAN     NOT NULL DEFAULT false,
  easy_max    BIGINT      NOT NULL DEFAULT 10000,  -- paise: bets UNDER this → 'low'
  hard_min    BIGINT      NOT NULL DEFAULT 20000,  -- paise: bets OVER this  → 'high'
  updated_by  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO amount_preset_config(id) VALUES(1) ON CONFLICT DO NOTHING;
