-- =====================================================================
-- Migration 004: Matka game — first-time guide flag
-- =====================================================================

-- Flag to send the "How to Play Matka" guide only once per user
ALTER TABLE users ADD COLUMN IF NOT EXISTS matka_seen BOOLEAN NOT NULL DEFAULT FALSE;
