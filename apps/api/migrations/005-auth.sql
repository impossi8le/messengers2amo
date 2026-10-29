-- Task #6: staff authentication, revocable server-side sessions, authorization scopes
-- and idempotency for operator connection commands.
-- Credentials are stored as hash+salt only; plaintext passwords never enter the database.
-- Sessions live in PostgreSQL so revocation is immediate for already-issued cookies.

CREATE TABLE __SCHEMA__.staff_credentials (
 company_id text NOT NULL, staff_id text NOT NULL,
 salt text NOT NULL CHECK(length(salt) BETWEEN 16 AND 128),
 password_hash text NOT NULL CHECK(length(password_hash) BETWEEN 64 AND 256),
 algorithm text NOT NULL DEFAULT 'scrypt' CHECK(algorithm IN ('scrypt')),
 version bigint NOT NULL DEFAULT 0 CHECK(version>=0),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(company_id,staff_id),
 FOREIGN KEY(company_id,staff_id) REFERENCES __SCHEMA__.staff(company_id,id)
);

-- One authorization grant per staff member. workshop_id NULL means company-wide scope.
CREATE TABLE __SCHEMA__.staff_access (
 company_id text NOT NULL, staff_id text NOT NULL,
 role text NOT NULL CHECK(role IN ('read','send','manage','admin')),
 workshop_id text,
 version bigint NOT NULL DEFAULT 0 CHECK(version>=0),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(company_id,staff_id),
 FOREIGN KEY(company_id,staff_id) REFERENCES __SCHEMA__.staff(company_id,id),
 FOREIGN KEY(company_id,workshop_id) REFERENCES __SCHEMA__.workshops(company_id,id)
);

-- Server-side session registry. Every authenticated request checks this row, so a
-- revoked row (or a deleted staff_access grant) invalidates a live cookie at once.
CREATE TABLE __SCHEMA__.staff_sessions (
 company_id text NOT NULL, id text NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
 staff_id text NOT NULL, epoch bigint NOT NULL CHECK(epoch>=0),
 issued_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 PRIMARY KEY(company_id,id),
 FOREIGN KEY(company_id,staff_id) REFERENCES __SCHEMA__.staff(company_id,id)
);
CREATE INDEX staff_sessions_staff_active ON __SCHEMA__.staff_sessions(company_id,staff_id)
 WHERE revoked_at IS NULL;

-- Idempotency ledger for connection mutations. A repeated key either replays the
-- stored connection or fails as IDEMPOTENCY_CONFLICT; it never mutates twice.
CREATE TABLE __SCHEMA__.connection_commands (
 company_id text NOT NULL,
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128),
 command text NOT NULL CHECK(length(command)>0),
 connection_id text,
 fingerprint text NOT NULL CHECK(length(fingerprint)=64),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(company_id,idempotency_key),
 FOREIGN KEY(company_id,connection_id) REFERENCES __SCHEMA__.connections(company_id,id)
);
