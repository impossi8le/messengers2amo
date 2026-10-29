-- amoCRM assignment workflow (#12): explicit source-of-truth policy, visible
-- conflicts, platform->CRM owner projection, last-sync diagnostics.
-- Storage only: rules live in src/integrations/amocrm/workflow.ts.

-- Which side wins when CRM and the platform disagree about the responsible user.
-- The policy is per company and versioned; changing it is audited.
CREATE TABLE __SCHEMA__.crm_assignment_policy (
 company_id text PRIMARY KEY REFERENCES __SCHEMA__.companies(id),
 source_of_truth text NOT NULL DEFAULT 'platform' CHECK (source_of_truth IN ('crm','platform')),
 version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
 updated_by text,
 updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (company_id, updated_by) REFERENCES __SCHEMA__.staff(company_id, id)
);

-- A disagreement is recorded, never resolved silently. `winner` is the policy in
-- force at detection time, so later policy edits do not rewrite history.
CREATE TABLE __SCHEMA__.crm_assignment_conflicts (
 company_id text NOT NULL, id text NOT NULL CHECK (length(id) > 0),
 account_id text NOT NULL, conversation_id text NOT NULL,
 crm_owner_ref text NOT NULL CHECK (length(crm_owner_ref) > 0),
 platform_owner_id text,
 desired_crm_owner_ref text,
 policy text NOT NULL CHECK (policy IN ('crm','platform')),
 winner text NOT NULL CHECK (winner IN ('crm','platform')),
 state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','resolved')),
 detected_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz,
 PRIMARY KEY (company_id, id),
 FOREIGN KEY (company_id, account_id) REFERENCES __SCHEMA__.crm_accounts(company_id, id),
 FOREIGN KEY (company_id, conversation_id) REFERENCES __SCHEMA__.conversations(company_id, id),
 FOREIGN KEY (company_id, platform_owner_id) REFERENCES __SCHEMA__.staff(company_id, id),
 CHECK (state <> 'resolved' OR resolved_at IS NOT NULL)
);

-- Desired vs. acknowledged CRM responsible user for one conversation. This is the
-- CRM projection of the local assignee; it never feeds back into work_items.
CREATE TABLE __SCHEMA__.crm_owner_projections (
 company_id text NOT NULL, account_id text NOT NULL, conversation_id text NOT NULL,
 desired_owner_ref text, projected_owner_ref text,
 state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','applied','failed','superseded')),
 error_code text, last_request_key text,
 version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (company_id, account_id, conversation_id),
 FOREIGN KEY (company_id, account_id) REFERENCES __SCHEMA__.crm_accounts(company_id, id),
 FOREIGN KEY (company_id, conversation_id) REFERENCES __SCHEMA__.conversations(company_id, id)
);

-- Outcome of the most recent read of CRM state for one conversation. `last_request_key`
-- makes a repeated manual resync a replay instead of a second external read.
CREATE TABLE __SCHEMA__.crm_sync_state (
 company_id text NOT NULL, account_id text NOT NULL, conversation_id text NOT NULL,
 last_request_key text,
 last_status text NOT NULL CHECK (last_status IN ('ok','lead_missing','failed','in_progress')),
 last_error_code text,
 last_attempt_at timestamptz NOT NULL DEFAULT now(),
 last_success_at timestamptz,
 last_result jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(last_result) = 'object'),
 version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
 PRIMARY KEY (company_id, account_id, conversation_id),
 FOREIGN KEY (company_id, account_id) REFERENCES __SCHEMA__.crm_accounts(company_id, id),
 FOREIGN KEY (company_id, conversation_id) REFERENCES __SCHEMA__.conversations(company_id, id)
);

-- Confirmed correspondence between an internal employee and an amoCRM user. An
-- absent row means the mapping is unconfirmed: the platform cannot project an owner.
CREATE TABLE __SCHEMA__.staff_crm_refs (
 company_id text NOT NULL, account_id text NOT NULL, staff_id text NOT NULL,
 crm_user_ref text NOT NULL CHECK (length(crm_user_ref) > 0),
 version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
 confirmed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (company_id, account_id, staff_id),
 FOREIGN KEY (company_id, account_id) REFERENCES __SCHEMA__.crm_accounts(company_id, id),
 FOREIGN KEY (company_id, staff_id) REFERENCES __SCHEMA__.staff(company_id, id)
);

-- Command ledger for workflow commands whose effect spans many work items
-- (access revocation). Replays return the stored result instead of acting twice.
CREATE TABLE __SCHEMA__.workflow_commands (
 company_id text NOT NULL, command_type text NOT NULL CHECK (length(command_type) > 0),
 request_key text NOT NULL CHECK (length(request_key) > 0),
 payload_fingerprint text NOT NULL CHECK (payload_fingerprint ~ '^[a-f0-9]{64}$'),
 result jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(result) = 'object'),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (company_id, command_type, request_key)
);

CREATE INDEX crm_assignment_conflicts_open ON __SCHEMA__.crm_assignment_conflicts(company_id, conversation_id)
 WHERE state = 'open';
