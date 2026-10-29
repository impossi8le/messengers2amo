-- Attention lifecycle provenance, operator reads, assignment CAS bookkeeping and
-- CRM owner isolation. Storage only: runtime rules live in src/domain and src/repo.
-- Never edit 001-006 after application.

-- An obligation inherits the start of waiting from the version it supersedes, so a
-- substantial edit does not reset SLA age. Supersession is explicit and permanent.
ALTER TABLE __SCHEMA__.attention_obligations ADD COLUMN opened_at timestamptz;
ALTER TABLE __SCHEMA__.attention_obligations ADD COLUMN supersedes_id text;
UPDATE __SCHEMA__.attention_obligations SET opened_at = created_at WHERE opened_at IS NULL;
ALTER TABLE __SCHEMA__.attention_obligations ALTER COLUMN opened_at SET DEFAULT now();
ALTER TABLE __SCHEMA__.attention_obligations ALTER COLUMN opened_at SET NOT NULL;
ALTER TABLE __SCHEMA__.attention_obligations ADD CONSTRAINT obligation_supersedes
 FOREIGN KEY (company_id, supersedes_id) REFERENCES __SCHEMA__.attention_obligations(company_id, id);
CREATE UNIQUE INDEX one_supersession_per_obligation ON __SCHEMA__.attention_obligations(company_id, supersedes_id)
 WHERE supersedes_id IS NOT NULL;
CREATE INDEX open_obligations_by_work ON __SCHEMA__.attention_obligations(company_id, work_item_id, attention_seq)
 WHERE state = 'open';

-- Reading a conversation is recorded separately and never changes obligation state.
CREATE TABLE __SCHEMA__.staff_read_marks (
 company_id text NOT NULL, conversation_id text NOT NULL, staff_id text NOT NULL,
 last_read_seq bigint NOT NULL CHECK (last_read_seq >= 0), read_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (company_id, conversation_id, staff_id),
 FOREIGN KEY (company_id, conversation_id) REFERENCES __SCHEMA__.conversations(company_id, id),
 FOREIGN KEY (company_id, staff_id) REFERENCES __SCHEMA__.staff(company_id, id)
);

-- Command replay ledger for assignment commands. Scope: company + command + key.
CREATE TABLE __SCHEMA__.work_item_commands (
 company_id text NOT NULL, command_type text NOT NULL CHECK (length(command_type) > 0),
 request_key text NOT NULL CHECK (length(request_key) > 0), work_item_id text NOT NULL,
 payload_fingerprint text NOT NULL CHECK (payload_fingerprint ~ '^[a-f0-9]{64}$'),
 result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (company_id, command_type, request_key),
 FOREIGN KEY (company_id, work_item_id) REFERENCES __SCHEMA__.work_items(company_id, id)
);

-- One row per accepted assignment version. Version is unique per work item, so a
-- replayed command cannot append a second history row for the same transition.
CREATE TABLE __SCHEMA__.assignment_history (
 company_id text NOT NULL, id text NOT NULL CHECK (length(id) > 0), work_item_id text NOT NULL,
 previous_owner_id text, owner_id text,
 assignment_version bigint NOT NULL CHECK (assignment_version >= 0),
 reason text NOT NULL CHECK (length(reason) > 0), actor_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (company_id, id), UNIQUE (company_id, work_item_id, assignment_version),
 FOREIGN KEY (company_id, work_item_id) REFERENCES __SCHEMA__.work_items(company_id, id),
 FOREIGN KEY (company_id, previous_owner_id) REFERENCES __SCHEMA__.staff(company_id, id),
 FOREIGN KEY (company_id, owner_id) REFERENCES __SCHEMA__.staff(company_id, id),
 FOREIGN KEY (company_id, actor_id) REFERENCES __SCHEMA__.staff(company_id, id)
);

-- The amoCRM contact/lead owner is a separate fact from the local work item assignee.
-- Its reference is an external CRM value, deliberately not a staff foreign key.
CREATE TABLE __SCHEMA__.crm_contact_owners (
 company_id text NOT NULL, conversation_id text NOT NULL,
 crm_owner_ref text NOT NULL CHECK (length(crm_owner_ref) > 0),
 version bigint NOT NULL DEFAULT 0 CHECK (version >= 0), observed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (company_id, conversation_id),
 FOREIGN KEY (company_id, conversation_id) REFERENCES __SCHEMA__.conversations(company_id, id)
);
