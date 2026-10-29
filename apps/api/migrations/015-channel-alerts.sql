-- Channel alerts: a durable record of the events an administrator must hear about.
--
-- The personal notification feed is a read-only projection of state that already
-- exists (open obligations, unknown sends, ownership transfers). A channel alert is
-- different: the fact itself is the event, and it must survive the condition that
-- produced it. A channel that was disabled and later re-enabled still happened, and
-- the operator has to be able to read about it afterwards.
--
-- Therefore the alert is stored, not projected. The row is the single source of
-- truth: the notification feed reads it, and the dedupe key keeps a repeated
-- trigger (the same revoked access seen by two workers) from producing two alerts.
--
-- PII rule: this table holds identifiers and safe codes only. No phone numbers, no
-- message text, no provider error bodies, no tokens. `error_code` is a closed
-- vocabulary of our own codes, never a provider payload.

ALTER TABLE __SCHEMA__.crm_accounts ADD COLUMN refresh_failure_count integer NOT NULL DEFAULT 0 CHECK (refresh_failure_count >= 0);

CREATE TABLE IF NOT EXISTS __SCHEMA__.channel_alerts (
  company_id text NOT NULL REFERENCES __SCHEMA__.companies(id),
  id text NOT NULL CHECK(length(id)>0),
  connection_id text NOT NULL,
  -- The four events the routing design names.
  kind text NOT NULL CHECK(kind IN ('channel_disabled','refresh_exhausted','send_rejected','manual_review')),
  -- Tenant-scoped deduplication: one alert per (company, dedupe key). The key is
  -- derived from the subject of the event (a connection version, an operation id),
  -- never from the message body.
  dedupe_key text NOT NULL CHECK(length(dedupe_key)>0),
  -- The staff member the route points at. Stored explicitly so the alert survives
  -- a later change of the route's recipient.
  recipient_staff_id text NOT NULL,
  -- Our own closed-vocabulary code. Never a provider error string.
  error_code text CHECK(error_code IS NULL OR error_code IN ('ACCESS_REVOKED','TOKEN_REFRESH_FAILED','SEND_REJECTED','OUTCOME_UNKNOWN','CHANNEL_DISABLED')),
  -- The administrative state the connection was in when the alert was raised.
  connection_state text CHECK(connection_state IS NULL OR length(connection_state)>0),
  -- Identifiers only: no message text, no phone number.
  conversation_id text CHECK(conversation_id IS NULL OR length(conversation_id)>0),
  external_message_id text CHECK(external_message_id IS NULL OR length(external_message_id)>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,id),
  UNIQUE(company_id,dedupe_key),
  FOREIGN KEY(company_id,connection_id) REFERENCES __SCHEMA__.connections(company_id,id),
  FOREIGN KEY(company_id,recipient_staff_id) REFERENCES __SCHEMA__.staff(company_id,id)
);

-- The feed reads the recipient's own alerts, newest first.
CREATE INDEX IF NOT EXISTS channel_alerts_recipient
  ON __SCHEMA__.channel_alerts(company_id, recipient_staff_id, created_at DESC, id DESC);
