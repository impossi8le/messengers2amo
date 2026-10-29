-- Indexes supporting the /metrics state counters.
--
-- Each metric query groups by state across a whole table. Without an index the
-- planner falls back to a sequential scan, so scrape cost would grow with the
-- retained history and compete with application traffic. These are covering
-- indexes on (state) only: small, cheap to maintain, and enough for a grouped count.

CREATE INDEX IF NOT EXISTS outbox_jobs_state ON __SCHEMA__.outbox_jobs(state);
CREATE INDEX IF NOT EXISTS inbox_events_state ON __SCHEMA__.inbox_events(state);
CREATE INDEX IF NOT EXISTS send_operations_state ON __SCHEMA__.send_operations(state);
CREATE INDEX IF NOT EXISTS attention_obligations_state ON __SCHEMA__.attention_obligations(state);
