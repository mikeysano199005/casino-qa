-- =====================================================================
-- Discord Casino — initial schema
-- All money stored as BIGINT paise (1 INR = 100 paise) to avoid float bugs
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─── enums ───────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE user_status AS ENUM ('active','flagged','banned');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE tx_type AS ENUM ('deposit','withdraw','bet','win','refund','bonus','adjust');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE tx_status AS ENUM ('pending','completed','failed','reversed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE wd_status AS ENUM ('pending','approved','rejected','paid');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE preset_mode AS ENUM ('house','low','medium','high');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE app_role AS ENUM ('admin','moderator','user');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── users ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  discord_id      TEXT UNIQUE NOT NULL,
  username        TEXT,
  status          user_status NOT NULL DEFAULT 'active',
  ip_hash         TEXT,
  device_fp       TEXT,
  withdraw_cooldown_until TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role     app_role NOT NULL,
  PRIMARY KEY (user_id, role)
);

-- ─── wallets ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wallets (
  user_id          UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  available        BIGINT NOT NULL DEFAULT 0 CHECK (available >= 0),
  locked           BIGINT NOT NULL DEFAULT 0 CHECK (locked >= 0),
  total_wagered    BIGINT NOT NULL DEFAULT 0,
  total_deposited  BIGINT NOT NULL DEFAULT 0,
  total_withdrawn  BIGINT NOT NULL DEFAULT 0,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── transactions ledger ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transactions (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id),
  type        tx_type NOT NULL,
  amount      BIGINT NOT NULL,            -- positive = credit, negative = debit
  balance_after BIGINT NOT NULL,
  status      tx_status NOT NULL DEFAULT 'completed',
  ref         TEXT,                        -- bet id, deposit id, withdraw id, etc.
  meta        JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tx_user_idx     ON transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tx_type_idx     ON transactions(type, created_at DESC);

-- ─── deposits ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS deposits (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id),
  cashfree_order_id   TEXT UNIQUE NOT NULL,
  amount              BIGINT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'created',  -- created|success|failed|expired
  signature_verified  BOOLEAN NOT NULL DEFAULT FALSE,
  raw_webhook         JSONB,
  credited_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── withdrawals ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS withdrawals (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id),
  amount      BIGINT NOT NULL CHECK (amount > 0),
  upi_id      TEXT,
  bank_details JSONB,
  status      wd_status NOT NULL DEFAULT 'pending',
  admin_id    TEXT,
  admin_note  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS wd_status_idx ON withdrawals(status, created_at DESC);

-- ─── games ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS game_rounds (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game            TEXT NOT NULL,                 -- colour|crash|mines|dice|blackjack|slots
  server_seed_hash TEXT NOT NULL,
  server_seed     TEXT,
  client_seed     TEXT,
  nonce           BIGINT,
  outcome         JSONB,
  total_pool      BIGINT NOT NULL DEFAULT 0,
  house_pnl       BIGINT NOT NULL DEFAULT 0,
  preset_mode     preset_mode NOT NULL DEFAULT 'house',
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS round_game_idx ON game_rounds(game, started_at DESC);

CREATE TABLE IF NOT EXISTS bets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id),
  round_id    UUID REFERENCES game_rounds(id),
  game        TEXT NOT NULL,
  stake       BIGINT NOT NULL CHECK (stake > 0),
  selection   JSONB NOT NULL,
  payout      BIGINT NOT NULL DEFAULT 0,
  result      TEXT,                              -- win|loss|push|pending
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS bets_user_idx  ON bets(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS bets_round_idx ON bets(round_id);

-- ─── presets ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS presets (
  scope       TEXT PRIMARY KEY,                  -- 'global' or game name
  mode        preset_mode NOT NULL DEFAULT 'house',
  updated_by  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS preset_history (
  id         BIGSERIAL PRIMARY KEY,
  scope      TEXT NOT NULL,
  old_mode   preset_mode,
  new_mode   preset_mode NOT NULL,
  changed_by TEXT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO presets(scope,mode) VALUES ('global','house') ON CONFLICT DO NOTHING;

-- ─── audit + fraud + bot status ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id         BIGSERIAL PRIMARY KEY,
  actor      TEXT,
  action     TEXT NOT NULL,
  target     TEXT,
  before     JSONB,
  after      JSONB,
  ip         TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fraud_signals (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID REFERENCES users(id),
  signal_type TEXT NOT NULL,
  severity    TEXT NOT NULL DEFAULT 'low',     -- low|med|high
  details     JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bot_status (
  id          INT PRIMARY KEY DEFAULT 1,
  last_seen   TIMESTAMPTZ,
  version     TEXT,
  CHECK (id = 1)
);
INSERT INTO bot_status(id) VALUES (1) ON CONFLICT DO NOTHING;

-- =====================================================================
-- Atomic balance mutation
-- Use FOR UPDATE so concurrent bets/deposits/withdrawals never race.
-- amount: positive = credit, negative = debit (against `available`)
-- lock_delta: positive moves available->locked, negative moves locked->available
-- =====================================================================
CREATE OR REPLACE FUNCTION apply_transaction(
  p_user_id    UUID,
  p_type       tx_type,
  p_amount     BIGINT,
  p_lock_delta BIGINT DEFAULT 0,
  p_ref        TEXT   DEFAULT NULL,
  p_meta       JSONB  DEFAULT '{}'
) RETURNS BIGINT
LANGUAGE plpgsql AS $$
DECLARE
  w RECORD;
  new_available BIGINT;
  new_locked    BIGINT;
BEGIN
  SELECT * INTO w FROM wallets WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO wallets(user_id) VALUES (p_user_id);
    SELECT * INTO w FROM wallets WHERE user_id = p_user_id FOR UPDATE;
  END IF;

  new_available := w.available + p_amount - GREATEST(p_lock_delta, 0) + GREATEST(-p_lock_delta, 0);
  new_locked    := w.locked    + p_lock_delta;

  IF new_available < 0 THEN
    RAISE EXCEPTION 'INSUFFICIENT_FUNDS';
  END IF;
  IF new_locked < 0 THEN
    RAISE EXCEPTION 'INSUFFICIENT_LOCKED';
  END IF;

  UPDATE wallets SET
    available       = new_available,
    locked          = new_locked,
    total_wagered   = total_wagered   + CASE WHEN p_type='bet'      THEN -p_amount ELSE 0 END,
    total_deposited = total_deposited + CASE WHEN p_type='deposit'  THEN  p_amount ELSE 0 END,
    total_withdrawn = total_withdrawn + CASE WHEN p_type='withdraw' THEN -p_amount ELSE 0 END,
    updated_at      = now()
  WHERE user_id = p_user_id;

  INSERT INTO transactions(user_id,type,amount,balance_after,ref,meta)
  VALUES (p_user_id,p_type,p_amount,new_available,p_ref,p_meta)
  RETURNING id INTO new_available;  -- reuse var

  RETURN new_available;
END $$;
