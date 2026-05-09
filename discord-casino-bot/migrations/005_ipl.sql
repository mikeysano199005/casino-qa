CREATE TABLE IF NOT EXISTS ipl_matches (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  title            TEXT        NOT NULL,
  team_a           TEXT        NOT NULL,
  team_b           TEXT        NOT NULL,
  status           TEXT        NOT NULL DEFAULT 'open' CHECK (status IN ('open','locked','settled','void')),
  winner           TEXT        CHECK (winner IN ('a','b')),
  pool_a           BIGINT      NOT NULL DEFAULT 0,
  pool_b           BIGINT      NOT NULL DEFAULT 0,
  lock_at          TIMESTAMPTZ NOT NULL,
  panel_message_id TEXT,
  channel_id       TEXT        NOT NULL,
  created_by       TEXT        NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_at       TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS ipl_bets (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id   UUID        NOT NULL REFERENCES ipl_matches(id),
  user_id    UUID        NOT NULL REFERENCES users(id),
  discord_id TEXT        NOT NULL,
  username   TEXT        NOT NULL,
  team       TEXT        NOT NULL CHECK (team IN ('a','b')),
  stake      BIGINT      NOT NULL,
  payout     BIGINT,
  result     TEXT        NOT NULL DEFAULT 'pending' CHECK (result IN ('pending','win','loss','void')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_at TIMESTAMPTZ,
  UNIQUE (match_id, user_id)
);

CREATE INDEX IF NOT EXISTS ipl_bets_match_id_idx ON ipl_bets(match_id);
CREATE INDEX IF NOT EXISTS ipl_bets_user_id_idx  ON ipl_bets(user_id);
