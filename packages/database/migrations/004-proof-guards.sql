-- Proof guards and known reference protection for send operations, attempts, and receipts.
-- Additive row-level guards without EXISTS checks.

-- 1. Protect immutable identity on send_attempts.
CREATE TRIGGER immutable_send_attempt_identity BEFORE UPDATE ON __SCHEMA__.send_attempts FOR EACH ROW
 EXECUTE FUNCTION __SCHEMA__.reject_identity_change('company_id','id','operation_id');

-- 2. Keep known provider IDs permanent using the existing provider guard.
-- Permits NULL-to-known reconciliation and same-value retries; prevents overwriting known provider IDs.
CREATE TRIGGER immutable_send_operation_provider_id BEFORE UPDATE ON __SCHEMA__.send_operations FOR EACH ROW
 EXECUTE FUNCTION __SCHEMA__.protect_provider_message_id();

CREATE TRIGGER immutable_send_attempt_provider_id BEFORE UPDATE ON __SCHEMA__.send_attempts FOR EACH ROW
 EXECUTE FUNCTION __SCHEMA__.protect_provider_message_id();

-- 3. Enforce identifier bounds on provider_receipt_links BEFORE proof lookup trigger fires.
-- Named receipt_link_identifier_bounds so it executes alphabetically before receipt_link_proof.
CREATE FUNCTION __SCHEMA__.receipt_link_identifier_bounds() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.conversation_id IS NULL OR length(NEW.conversation_id) NOT BETWEEN 1 AND 128
    OR NEW.message_id IS NULL OR length(NEW.message_id) NOT BETWEEN 1 AND 128
    OR (NEW.operation_id IS NOT NULL AND length(NEW.operation_id) NOT BETWEEN 1 AND 128)
    OR (NEW.attempt_id IS NOT NULL AND length(NEW.attempt_id) NOT BETWEEN 1 AND 128) THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='receipt_link_identifier_bounds';
 END IF;
 RETURN NEW;
END $$;

CREATE TRIGGER receipt_link_identifier_bounds BEFORE INSERT ON __SCHEMA__.provider_receipt_links FOR EACH ROW
 EXECUTE FUNCTION __SCHEMA__.receipt_link_identifier_bounds();
