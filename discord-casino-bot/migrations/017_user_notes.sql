-- Private admin notes shown on the web user-profile page.
ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_notes TEXT;
