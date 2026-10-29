-- Imported CRM identity is separate from local login/administrative privileges.
CREATE TABLE __SCHEMA__.crm_directory_sync (
 company_id text NOT NULL, account_id text NOT NULL,
 generation bigint NOT NULL DEFAULT 0, version bigint NOT NULL DEFAULT 0,
 last_success_at timestamptz, last_error_code text,
 PRIMARY KEY(company_id,account_id),
 FOREIGN KEY(company_id,account_id) REFERENCES __SCHEMA__.crm_accounts(company_id,id)
);
CREATE TABLE __SCHEMA__.crm_directory_roles (
 company_id text NOT NULL, account_id text NOT NULL, id text NOT NULL, display_name text NOT NULL,
 PRIMARY KEY(company_id,account_id,id),
 FOREIGN KEY(company_id,account_id) REFERENCES __SCHEMA__.crm_accounts(company_id,id)
);
CREATE TABLE __SCHEMA__.crm_directory_users (
 company_id text NOT NULL, account_id text NOT NULL, crm_user_ref text NOT NULL,
 staff_id text NOT NULL, display_name text NOT NULL,
 amojo_user_ref text CHECK(amojo_user_ref IS NULL OR length(amojo_user_ref)>0),
 is_active boolean NOT NULL, crm_is_admin boolean NOT NULL,
 role_id text, role_name text, group_id text, group_name text,
 imported_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(company_id,account_id,crm_user_ref),
 UNIQUE(company_id,account_id,staff_id), UNIQUE(company_id,account_id,amojo_user_ref),
 FOREIGN KEY(company_id,account_id) REFERENCES __SCHEMA__.crm_accounts(company_id,id),
 FOREIGN KEY(company_id,staff_id) REFERENCES __SCHEMA__.staff(company_id,id)
);
CREATE TABLE __SCHEMA__.channel_crm_access (
 company_id text NOT NULL, connection_id text NOT NULL, account_id text NOT NULL, crm_user_ref text NOT NULL,
 role text NOT NULL CHECK(role IN ('manager','supervisor','quality')),
 PRIMARY KEY(company_id,connection_id,account_id,crm_user_ref),
 FOREIGN KEY(company_id,connection_id) REFERENCES __SCHEMA__.connections(company_id,id),
 FOREIGN KEY(company_id,account_id,crm_user_ref) REFERENCES __SCHEMA__.crm_directory_users(company_id,account_id,crm_user_ref)
);
-- Existing connections continue to use their existing native CRM authorizations.
-- Applying channel roles switches this connection to the explicit access policy.
ALTER TABLE __SCHEMA__.connections ADD COLUMN crm_access_enabled boolean NOT NULL DEFAULT false;
