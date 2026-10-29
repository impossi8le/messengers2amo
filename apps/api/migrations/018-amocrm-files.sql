-- Durable identity for REST capture file delivery; upload uncertainty must never
-- turn into an automatic second file. No expiring provider URLs/tokens are stored.
CREATE TABLE __SCHEMA__.amocrm_file_deliveries (
 company_id text NOT NULL, account_id text NOT NULL, message_id text NOT NULL,
 lead_id text NOT NULL CHECK (lead_id ~ '^[1-9][0-9]*$'),
 file_uuid uuid,
 state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','uploading','uploaded','linked','unknown')),
 original_name text NOT NULL, mime_type text NOT NULL,
 byte_size bigint NOT NULL CHECK (byte_size>=0 AND byte_size<=20971520),
 sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(company_id,account_id,message_id),
 FOREIGN KEY(company_id,account_id) REFERENCES __SCHEMA__.crm_accounts(company_id,id),
 FOREIGN KEY(company_id,message_id) REFERENCES __SCHEMA__.messages(company_id,id),
 CHECK (state NOT IN ('uploaded','linked') OR file_uuid IS NOT NULL)
);
