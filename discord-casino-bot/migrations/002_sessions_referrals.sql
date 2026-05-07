-- =====================================================================
-- Migration 002: persistent game sessions + referral system
-- =====================================================================

-- ─── Persistent game sessions (mines / blackjack) ────────────────────
-- Survives bot restarts; locked funds are never stranded.
CREATE TABLE IF NOT EXISTS game_sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game        TEXT NOT NULL,
  data        JSONB NOT NULL DEFAULT '{}',
  bet_id      UUID REFERENCES bets(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, game)
);
CREATE INDEX IF NOT EXISTS gs_user_idx ON game_sessions(user_id);

-- ─── Referrals ───────────────────────────────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code TEXT UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by   UUID REFERENCES users(id);

-- Auto-generate referral code on insert
CREATE OR REPLACE FUNCTION generate_referral_code()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.referral_code IS NULL THEN
    NEW.referral_code := upper(substring(encode(gen_random_bytes(4), 'hex'), 1, 8));
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS users_referral_code ON users;
CREATE TRIGGER users_referral_code
  BEFORE INSERT ON users
  FOR EACH ROW EXECUTE FUNCTION generate_referral_code();

-- Backfill existing rows
UPDATE users
  SET referral_code = upper(substring(encode(gen_random_bytes(4), 'hex'), 1, 8))
  WHERE referral_code IS NULL;

-- One bonus record per referred user — prevents double-credit
CREATE TABLE IF NOT EXISTS referral_bonuses (
  id          BIGSERIAL PRIMARY KEY,
  referrer_id UUID NOT NULL REFERENCES users(id),
  referee_id  UUID NOT NULL UNIQUE REFERENCES users(id),
  amount      BIGINT NOT NULL,
  credited_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rb_referrer_idx ON referral_bonuses(referrer_id);
