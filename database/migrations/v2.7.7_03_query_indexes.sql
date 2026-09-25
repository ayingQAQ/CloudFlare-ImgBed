CREATE INDEX IF NOT EXISTS idx_files_expires_at ON files(expires_at);
CREATE INDEX IF NOT EXISTS idx_settings_expires_at ON settings(expires_at);
CREATE INDEX IF NOT EXISTS idx_files_page ON files(timestamp DESC, id ASC);
