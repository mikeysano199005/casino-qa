-- Convert preset_mode enum columns to TEXT so any preset value works
-- without needing ALTER TYPE ADD VALUE (which has transaction issues).
ALTER TABLE presets       ALTER COLUMN mode          TYPE TEXT USING mode::TEXT;
ALTER TABLE preset_history ALTER COLUMN old_mode     TYPE TEXT USING old_mode::TEXT;
ALTER TABLE preset_history ALTER COLUMN new_mode     TYPE TEXT USING new_mode::TEXT;
ALTER TABLE game_rounds   ALTER COLUMN preset_mode   TYPE TEXT USING preset_mode::TEXT;
