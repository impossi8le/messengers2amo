-- #18: exactly one outbound sender per channel asset.
-- One physical number/bot/community can never have two active send owners.
-- Ownership changes only through an explicit release followed by a new claim.
CREATE TABLE __SCHEMA__.channel_send_owners (
 company_id text NOT NULL REFERENCES __SCHEMA__.companies(id),
 channel_key text NOT NULL CHECK(length(channel_key)>0),
 owner text NOT NULL CHECK(length(owner)>0),
 claimed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(company_id, channel_key)
);
