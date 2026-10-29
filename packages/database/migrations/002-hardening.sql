-- Hardening after independent real-PG18 RED. Never edit 001 after application.
-- Storage guarantees only: runtime must seal snapshots before composer handoff (#5).
-- Quiesce the three related write surfaces together while backfilling/installing
-- triggers. This is a transactional, blocking migration, not an online rollout.
LOCK TABLE __SCHEMA__.send_operations, __SCHEMA__.reply_snapshot_items, __SCHEMA__.reply_snapshots IN ACCESS EXCLUSIVE MODE;

-- NULL is a legitimate unknown outbound provider ID. Populated references must match
-- the authoritative message; the FK also validates existing populated rows on upgrade.
ALTER TABLE __SCHEMA__.messages ADD CONSTRAINT message_provider_reference
 UNIQUE(company_id,id,provider_message_id);
ALTER TABLE __SCHEMA__.attachments ADD CONSTRAINT attachment_provider_message
 FOREIGN KEY(company_id,message_id,external_message_id)
 REFERENCES __SCHEMA__.messages(company_id,id,provider_message_id);

CREATE FUNCTION __SCHEMA__.protect_known_reference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(OLD)->TG_ARGV[0]) <> 'null'::jsonb
    AND (to_jsonb(OLD)->TG_ARGV[0]) IS DISTINCT FROM (to_jsonb(NEW)->TG_ARGV[0]) THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='immutable_known_reference';
 END IF;
 RETURN NEW;
END $$;
-- Retain original attachment identity, but permit the original unknown provider ID
-- to be reconciled once. Same-value retries are harmless; filled IDs cannot clear.
DROP TRIGGER immutable_attachment_origin ON __SCHEMA__.attachments;
CREATE TRIGGER immutable_attachment_origin BEFORE UPDATE ON __SCHEMA__.attachments FOR EACH ROW
 EXECUTE FUNCTION __SCHEMA__.reject_identity_change('company_id','id','message_id','conversation_id','connection_id','binding_epoch','external_chat_id');
CREATE TRIGGER immutable_attachment_provider_id BEFORE UPDATE ON __SCHEMA__.attachments FOR EACH ROW
 EXECUTE FUNCTION __SCHEMA__.protect_known_reference('external_message_id');
CREATE TRIGGER immutable_connection_identity BEFORE UPDATE ON __SCHEMA__.connection_identities FOR EACH ROW
 EXECUTE FUNCTION __SCHEMA__.reject_identity_change('company_id','connection_id','binding_epoch');
CREATE TRIGGER immutable_known_external_identity BEFORE UPDATE ON __SCHEMA__.connection_identities FOR EACH ROW
 EXECUTE FUNCTION __SCHEMA__.protect_known_reference('external_identity_ref');
CREATE TRIGGER immutable_conversation_lead_origin BEFORE UPDATE ON __SCHEMA__.conversation_leads FOR EACH ROW
 EXECUTE FUNCTION __SCHEMA__.reject_identity_change('company_id','id','account_id','conversation_id','lead_id');
CREATE TRIGGER immutable_attachment_lead_origin BEFORE UPDATE ON __SCHEMA__.attachment_lead_links FOR EACH ROW
 EXECUTE FUNCTION __SCHEMA__.reject_identity_change('company_id','attachment_id','account_id','lead_id');

-- A persistent header seal survives operation deletion, even for an empty snapshot.
-- Backfill references which existed before this migration; FK/transaction locks of
-- this migration prevent partial publication of the new invariant.
ALTER TABLE __SCHEMA__.reply_snapshots ADD COLUMN sealed_at timestamptz;
UPDATE __SCHEMA__.reply_snapshots s SET sealed_at=clock_timestamp()
 WHERE EXISTS (SELECT 1 FROM __SCHEMA__.send_operations op
  WHERE op.company_id=s.company_id AND op.snapshot_id=s.id);

CREATE FUNCTION __SCHEMA__.protect_snapshot_seal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.sealed_at IS NOT NULL THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='sealed_snapshot_cannot_delete';
  END IF;
  RETURN OLD;
 END IF;
 IF OLD.sealed_at IS NOT NULL AND OLD.sealed_at IS DISTINCT FROM NEW.sealed_at THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='sealed_snapshot_cannot_unseal';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_snapshot_seal BEFORE UPDATE OF sealed_at ON __SCHEMA__.reply_snapshots FOR EACH ROW
 EXECUTE FUNCTION __SCHEMA__.protect_snapshot_seal();
CREATE TRIGGER retain_sealed_snapshot BEFORE DELETE ON __SCHEMA__.reply_snapshots FOR EACH ROW
 EXECUTE FUNCTION __SCHEMA__.protect_snapshot_seal();

CREATE FUNCTION __SCHEMA__.seal_operation_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.snapshot_id IS NOT NULL THEN
  -- This is an actual MVCC write, not just a row lock or an EXISTS check. A
  -- membership writer with a pre-existing RR snapshot receives serialization
  -- failure after waiting; READ COMMITTED sees the committed persistent seal.
  UPDATE __SCHEMA__.reply_snapshots SET sealed_at=COALESCE(sealed_at,clock_timestamp())
   WHERE company_id=NEW.company_id AND id=NEW.snapshot_id;
 END IF;
 -- The existing composite FK verifies work/conversation scope. Invalid operation
 -- insertion rolls back its header update together with the operation.
 RETURN NEW;
END $$;
CREATE TRIGGER seal_accepted_operation_snapshot BEFORE INSERT ON __SCHEMA__.send_operations FOR EACH ROW
 EXECUTE FUNCTION __SCHEMA__.seal_operation_snapshot();

CREATE FUNCTION __SCHEMA__.protect_snapshot_membership() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_company text; old_snapshot text; new_company text; new_snapshot text; header record;
BEGIN
 IF TG_OP<>'INSERT' THEN old_company:=OLD.company_id; old_snapshot:=OLD.snapshot_id; END IF;
 IF TG_OP<>'DELETE' THEN new_company:=NEW.company_id; new_snapshot:=NEW.snapshot_id; END IF;
 -- Lock both old/new headers in a stable order for a membership move. Acceptance
 -- writes this same header. No unlocked EXISTS check can authorize a late member.
 FOR header IN SELECT s.company_id,s.id,s.sealed_at FROM __SCHEMA__.reply_snapshots s
   WHERE (s.company_id=old_company AND s.id=old_snapshot)
      OR (s.company_id=new_company AND s.id=new_snapshot)
   ORDER BY s.company_id,s.id FOR UPDATE
 LOOP
  IF header.sealed_at IS NOT NULL THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='sealed_snapshot_membership';
  END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_accepted_snapshot_membership BEFORE INSERT OR UPDATE OR DELETE ON __SCHEMA__.reply_snapshot_items FOR EACH ROW
 EXECUTE FUNCTION __SCHEMA__.protect_snapshot_membership();
-- Initial members may be constructed before sealing; #5 must explicitly seal before
-- presenting an immutable composer snapshot. This migration does not implement
-- snapshot freshness, subset validation, CAS admission, dispatch or provider I/O.
