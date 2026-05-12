ALTER TABLE amount_preset_config ADD COLUMN IF NOT EXISTS easy_preset   TEXT NOT NULL DEFAULT 'low';
ALTER TABLE amount_preset_config ADD COLUMN IF NOT EXISTS medium_preset TEXT NOT NULL DEFAULT 'medium';
ALTER TABLE amount_preset_config ADD COLUMN IF NOT EXISTS hard_preset   TEXT NOT NULL DEFAULT 'high';
