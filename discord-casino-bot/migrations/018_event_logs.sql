-- Mirror of every log/event so the web panel can show all activity even when
-- the bot can't post to Discord channels.
CREATE TABLE IF NOT EXISTS event_logs (
  id         BIGSERIAL PRIMARY KEY,
  kind       TEXT NOT NULL,
  title      TEXT,
  body       TEXT,
  discord_id TEXT,
  amount     BIGINT,
  meta       JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS event_logs_created_idx ON event_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS event_logs_kind_idx    ON event_logs(kind);
