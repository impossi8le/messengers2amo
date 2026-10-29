CREATE TABLE __SCHEMA__.amocrm_outbound_files (
 company_id text NOT NULL,
 operation_id text NOT NULL,
 account_id text NOT NULL,
 lead_id text NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','uploading','uploaded','linked','unknown')),
 file_uuid uuid,
 original_name text NOT NULL,
 mime_type text NOT NULL,
 byte_size bigint CHECK(byte_size BETWEEN 0 AND 20971520),
 sha256 text CHECK(sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(company_id,operation_id),
 FOREIGN KEY(company_id,operation_id) REFERENCES __SCHEMA__.send_operations(company_id,id),
 FOREIGN KEY(company_id,account_id) REFERENCES __SCHEMA__.crm_accounts(company_id,id),
 CHECK(state NOT IN ('uploaded','linked') OR (file_uuid IS NOT NULL AND byte_size IS NOT NULL AND sha256 IS NOT NULL))
);
