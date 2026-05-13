CREATE TABLE IF NOT EXISTS prediction_purchases (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  discord_id          TEXT        NOT NULL,
  email               TEXT,
  phone               TEXT,
  product             TEXT        NOT NULL CHECK (product IN ('matka', 'colour', 'slots')),
  slots_symbol_index  INT,
  price_paise         BIGINT      NOT NULL,
  cashfree_order_id   TEXT        UNIQUE NOT NULL,
  paid_at             TIMESTAMPTZ,
  delivered_at        TIMESTAMPTZ,
  expired_at          TIMESTAMPTZ,
  expired_reason      TEXT,
  prior_bet_verified  BOOLEAN     DEFAULT FALSE,
  created_at          TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pred_discord  ON prediction_purchases(discord_id);
CREATE INDEX IF NOT EXISTS idx_pred_pending  ON prediction_purchases(product, paid_at, delivered_at, expired_at);
