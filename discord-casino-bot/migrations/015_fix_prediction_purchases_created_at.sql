ALTER TABLE prediction_purchases ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
