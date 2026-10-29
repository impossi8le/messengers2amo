-- Task #26: workshop membership and marketing origin persistence.
-- Storage only; authorization and routing rules live in src/workshops.

-- A workshop is a business unit distinct from a department. A staff member may
-- work in several workshops; that relation is explicit and never derived from
-- department membership or from a display name.
CREATE TABLE __SCHEMA__.workshop_staff (
 company_id text NOT NULL, workshop_id text NOT NULL, staff_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(company_id,workshop_id,staff_id),
 FOREIGN KEY(company_id,workshop_id) REFERENCES __SCHEMA__.workshops(company_id,id),
 FOREIGN KEY(company_id,staff_id) REFERENCES __SCHEMA__.staff(company_id,id)
);

-- The advertising origin belongs to customer acquisition and is owned by the
-- marketing source. Binding a technical chat source must never rewrite it. Once
-- observed, the origin code is immutable; a correction is a new observation in
-- the CRM, not a silent overwrite here.
CREATE TABLE __SCHEMA__.crm_marketing_origins (
 company_id text NOT NULL, account_id text NOT NULL, conversation_id text NOT NULL,
 origin_code text NOT NULL CHECK(length(origin_code)>0),
 source_ref text CHECK(source_ref IS NULL OR length(source_ref)>0),
 observed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(company_id,account_id,conversation_id),
 FOREIGN KEY(company_id,account_id) REFERENCES __SCHEMA__.crm_accounts(company_id,id),
 FOREIGN KEY(company_id,conversation_id) REFERENCES __SCHEMA__.conversations(company_id,id)
);
CREATE TRIGGER immutable_marketing_origin BEFORE UPDATE ON __SCHEMA__.crm_marketing_origins FOR EACH ROW
 EXECUTE FUNCTION __SCHEMA__.reject_identity_change('company_id','account_id','conversation_id','origin_code');

-- Delivery to the archive is a separate fact from the index acknowledgement.
-- `delivered_at` is set once the adapter port acknowledged a delivery, so a
-- repeated request replays the recorded outcome instead of sending a duplicate.
ALTER TABLE __SCHEMA__.archive_handoff_jobs ADD COLUMN delivered_at timestamptz;
