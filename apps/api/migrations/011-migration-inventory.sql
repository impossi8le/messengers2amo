-- Task #17: pseudonymous registry of current messaging connections.
-- Storage only: conflict rules (one active outbound sender and one active inbound
-- receiver per asset) live in src/migration/inventory.ts. The table deliberately has
-- no uniqueness constraint on active ownership, because the registry is filled in
-- gradually and may contain incomplete "UNKNOWN" cards until the owner confirms them.
-- No phone numbers, tokens or client identifiers are stored here: aliases are pseudonyms.

CREATE TABLE __SCHEMA__.migration_inventory_connections (
 company_id text NOT NULL REFERENCES __SCHEMA__.companies(id),
 alias text NOT NULL CHECK (length(alias) BETWEEN 1 AND 128),
 channel text NOT NULL CHECK (channel IN ('telegram','whatsapp','max','vk')),
 mode text NOT NULL CHECK (length(mode) BETWEEN 1 AND 64),
 environment text NOT NULL CHECK (environment IN ('production','test')),
 active boolean NOT NULL DEFAULT true,
 asset_alias text NOT NULL CHECK (length(asset_alias) BETWEEN 1 AND 128),
 owner text NOT NULL CHECK (length(owner) BETWEEN 1 AND 128),
 inbound_transport text NOT NULL CHECK (inbound_transport IN ('webhook','polling','callback','long_poll','none','unknown')),
 inbound_subscriber text CHECK (inbound_subscriber IS NULL OR length(inbound_subscriber) BETWEEN 1 AND 128),
 inbound_enabled boolean NOT NULL DEFAULT false,
 outbound_owner text NOT NULL CHECK (outbound_owner IN ('wazzup','new_contour','amocrm','manual','none','unknown')),
 outbound_enabled boolean NOT NULL DEFAULT false,
 crm_projection_owner text CHECK (crm_projection_owner IS NULL OR length(crm_projection_owner) BETWEEN 1 AND 128),
 crm_projection_enabled boolean NOT NULL DEFAULT false,
 capabilities jsonb NOT NULL CHECK (jsonb_typeof(capabilities) = 'object'),
 history_export text NOT NULL CHECK (history_export IN ('available','partial','unavailable','unknown')),
 notes text CHECK (notes IS NULL OR length(notes) <= 2000),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (company_id, alias)
);

-- Conflict validation groups active production rows by asset.
CREATE INDEX migration_inventory_by_asset
 ON __SCHEMA__.migration_inventory_connections(company_id, channel, asset_alias)
 WHERE active;
