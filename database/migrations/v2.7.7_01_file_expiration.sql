-- Existing installations only; fresh installations include this column in init.sql.
-- The adapter also checks each table before use, including partially applied upgrades.
ALTER TABLE files ADD COLUMN expires_at INTEGER;
