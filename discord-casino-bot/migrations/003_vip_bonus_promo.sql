-- =====================================================================
-- Migration 003: VIP tiers, bonus wagering requirements, promo codes,
--                welcome DM flag, updated apply_transaction
-- =====================================================================

-- ─── Users: VIP tier + welcome DM flag ──────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS vip_tier      SMALLINT NOT NULL DEFAULT 0;
  -- 0=None  1=Bronze  2=Silver  3=Gold  4=Platinum
ALTER TABLE users ADD COLUMN IF NOT EXISTS welcome_sent  BOOLEAN  NOT NULL DEFAULT FALSE;

-- ─── Wallets: bonus wagering tracking ───────────────────────────────
ALTER TABLE wallets
  ADD COLUMN IF NOT EXISTS bonus_balance  BIGINT NOT NULL DEFAULT 0 CHECK (bonus_balance  >= 0),
  ADD COLUMN IF NOT EXISTS wager_pending  BIGINT NOT NULL DEFAULT 0 CHECK (wager_pending  >= 0);

-- ─── Promo codes ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS promo_codes (
  id           UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  code         TEXT    UNIQUE NOT NULL,
  bonus_amount BIGINT  NOT NULL,
  wager_mult   SMALLINT NOT NULL DEFAULT 5,
  max_uses     INT     NOT NULL DEFAULT 100,
  uses_count   INT     NOT NULL DEFAULT 0,
  expires_at   TIMESTAMPTZ,
  created_by   TEXT,
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS promo_uses (
  promo_id UUID NOT NULL REFERENCES promo_codes(id),
  user_id  UUID NOT NULL REFERENCES users(id),
  used_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (promo_id, user_id)
);
CREATE INDEX IF NOT EXISTS pu_user_idx ON promo_uses(user_id);

-- =====================================================================
-- Updated apply_transaction: tracks wagering progress automatically
-- when a bet stake is locked (type='bet', lock_delta > 0)
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
  w             RECORD;
  new_available BIGINT;
  new_locked    BIGINT;
  new_bonus_bal BIGINT;
  new_wager_pnd BIGINT;
BEGIN
  SELECT * INTO w FROM wallets WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO wallets(user_id) VALUES (p_user_id);
    SELECT * INTO w FROM wallets WHERE user_id = p_user_id FOR UPDATE;
  END IF;

  new_available := w.available + p_amount - GREATEST(p_lock_delta, 0) + GREATEST(-p_lock_delta, 0);
  new_locked    := w.locked    + p_lock_delta;
  new_bonus_bal := w.bonus_balance;
  new_wager_pnd := w.wager_pending;

  -- Deduct from wagering requirement whenever a bet stake is placed
  IF p_type = 'bet' AND p_lock_delta > 0 THEN
    new_wager_pnd := GREATEST(0, w.wager_pending - p_lock_delta);
    IF new_wager_pnd = 0 THEN
      new_bonus_bal := 0;  -- bonus fully unlocked
    END IF;
  END IF;

  IF new_available < 0 THEN RAISE EXCEPTION 'INSUFFICIENT_FUNDS';    END IF;
  IF new_locked    < 0 THEN RAISE EXCEPTION 'INSUFFICIENT_LOCKED';   END IF;
  IF new_bonus_bal < 0 THEN new_bonus_bal := 0;                      END IF;

  UPDATE wallets SET
    available       = new_available,
    locked          = new_locked,
    bonus_balance   = new_bonus_bal,
    wager_pending   = new_wager_pnd,
    total_wagered   = total_wagered   + CASE WHEN p_type = 'bet'      THEN -p_amount ELSE 0 END,
    total_deposited = total_deposited + CASE WHEN p_type = 'deposit'  THEN  p_amount ELSE 0 END,
    total_withdrawn = total_withdrawn + CASE WHEN p_type = 'withdraw' THEN -p_amount ELSE 0 END,
    updated_at      = now()
  WHERE user_id = p_user_id;

  INSERT INTO transactions(user_id, type, amount, balance_after, ref, meta)
  VALUES (p_user_id, p_type, p_amount, new_available, p_ref, p_meta)
  RETURNING id INTO new_available;   -- reuse var

  RETURN new_available;
END $$;
