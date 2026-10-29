ALTER TABLE __SCHEMA__.connections ADD COLUMN display_name text CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 120);
