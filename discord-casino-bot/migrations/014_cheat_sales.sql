CREATE TABLE IF NOT EXISTS cheat_sales (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cashfree_order_id TEXT UNIQUE NOT NULL,
  buyer_name        TEXT NOT NULL,
  buyer_phone       TEXT NOT NULL,
  amount            BIGINT NOT NULL,
  ticket_channel_id TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'created',
  credited_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
