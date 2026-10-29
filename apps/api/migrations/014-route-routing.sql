-- Route-level routing settings for the amoCRM projection.
--
-- The funnel has lived on connection_routes since 010-workshops.sql, but the stage
-- inside it was not selectable, so a new lead always landed on the first stage.
-- These three columns answer the three questions an admin asks per channel:
-- which stage new leads start on, who hears about a broken channel, and whether a
-- Russian number typed as 8XXXXXXXXXX should be matched against +7XXXXXXXXXX.

ALTER TABLE __SCHEMA__.connection_routes
  ADD COLUMN IF NOT EXISTS status_id text,
  ADD COLUMN IF NOT EXISTS alert_staff_id text,
  ADD COLUMN IF NOT EXISTS normalize_phone boolean NOT NULL DEFAULT false;

ALTER TABLE __SCHEMA__.connection_routes
  DROP CONSTRAINT IF EXISTS connection_routes_status_id_check;
ALTER TABLE __SCHEMA__.connection_routes
  ADD CONSTRAINT connection_routes_status_id_check
  CHECK (status_id IS NULL OR length(status_id) > 0);

ALTER TABLE __SCHEMA__.connection_routes
  DROP CONSTRAINT IF EXISTS connection_routes_alert_staff_fk;
ALTER TABLE __SCHEMA__.connection_routes
  ADD CONSTRAINT connection_routes_alert_staff_fk
  FOREIGN KEY (company_id, alert_staff_id) REFERENCES __SCHEMA__.staff(company_id, id);
