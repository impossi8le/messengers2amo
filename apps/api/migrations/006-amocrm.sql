-- amoCRM integration-local state (#10/#11).
-- CRM domain tables stay in the shared package migrations. These tables hold
-- channel/scope secrets, OAuth state, ambiguity records and message links that
-- belong to this service only. Secrets are stored as AES-256-GCM envelopes.

CREATE TABLE __SCHEMA__.amocrm_oauth_states (
 company_id text NOT NULL,
 account_id text NOT NULL,
 nonce text NOT NULL CHECK(length(nonce) BETWEEN 16 AND 128),
 account_domain text NOT NULL CHECK(length(account_domain)>0),
 redirect_uri text NOT NULL CHECK(length(redirect_uri)>0),
 created_at timestamptz NOT NULL DEFAULT now(),
 consumed_at timestamptz,
 PRIMARY KEY(company_id,nonce),
 FOREIGN KEY(company_id,account_id) REFERENCES __SCHEMA__.crm_accounts(company_id,id)
);

CREATE TABLE __SCHEMA__.amocrm_channels (
 company_id text NOT NULL,
 account_id text NOT NULL,
 scope_id text NOT NULL CHECK(length(scope_id)>0),
 channel_code text,
 secret_enc text NOT NULL CHECK(length(secret_enc)>0),
 connection_id text NOT NULL,
 binding_epoch bigint NOT NULL CHECK(binding_epoch>=0),
 amojo_account_id text NOT NULL CHECK(length(amojo_account_id)>0),
 state text NOT NULL DEFAULT 'connected' CHECK(state IN ('connected','disabled')),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(company_id,scope_id),
 UNIQUE(scope_id),
 UNIQUE(company_id,account_id,scope_id),
 FOREIGN KEY(company_id,account_id) REFERENCES __SCHEMA__.crm_accounts(company_id,id),
 FOREIGN KEY(company_id,connection_id,binding_epoch) REFERENCES __SCHEMA__.connection_identities(company_id,connection_id,binding_epoch)
);

CREATE TABLE __SCHEMA__.amocrm_ambiguous_matches (
 company_id text NOT NULL,
 id text NOT NULL CHECK(length(id)>0),
 account_id text NOT NULL,
 conversation_id text NOT NULL,
 reason text NOT NULL CHECK(length(reason)>0),
 candidates jsonb NOT NULL CHECK(jsonb_typeof(candidates)='array'),
 state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','resolved','dismissed')),
 resolved_contact_id text,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(company_id,id),
 UNIQUE(company_id,account_id,conversation_id,reason),
 FOREIGN KEY(company_id,account_id) REFERENCES __SCHEMA__.crm_accounts(company_id,id),
 FOREIGN KEY(company_id,conversation_id) REFERENCES __SCHEMA__.conversations(company_id,id)
);

-- Message identity observed from amoCRM. The provider message key is the
-- immutable external ID; the amoCRM ID is filled once and never rewritten.
CREATE TABLE __SCHEMA__.amocrm_message_links (
 company_id text NOT NULL,
 account_id text NOT NULL,
 conversation_id text NOT NULL,
 provider_message_id text NOT NULL CHECK(length(provider_message_id)>0),
 amo_message_id text NOT NULL CHECK(length(amo_message_id)>0),
 direction text NOT NULL CHECK(direction IN ('in','out')),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(company_id,account_id,conversation_id,provider_message_id),
 FOREIGN KEY(company_id,account_id) REFERENCES __SCHEMA__.crm_accounts(company_id,id),
 FOREIGN KEY(company_id,conversation_id) REFERENCES __SCHEMA__.conversations(company_id,id)
);

CREATE TABLE __SCHEMA__.amocrm_oauth_audit (
 company_id text NOT NULL,
 id text NOT NULL CHECK(length(id)>0),
 account_id text NOT NULL,
 event text NOT NULL CHECK(event IN ('authorized','refreshed','revoked','reconnected','refresh_rate_limited')),
 detail text,
 recorded_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(company_id,id),
 FOREIGN KEY(company_id,account_id) REFERENCES __SCHEMA__.crm_accounts(company_id,id)
);

CREATE INDEX amocrm_message_link_amo ON __SCHEMA__.amocrm_message_links(company_id,account_id,amo_message_id);
CREATE INDEX amocrm_oauth_state_age ON __SCHEMA__.amocrm_oauth_states(company_id,created_at);
