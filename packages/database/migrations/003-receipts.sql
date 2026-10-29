-- Append-only pre-normalization facts; no send/coverage projection effects.
CREATE TABLE __SCHEMA__.provider_receipt_evidence (
 company_id text NOT NULL, id text NOT NULL CHECK(length(id)>0),
 connection_id text NOT NULL, binding_epoch bigint NOT NULL CHECK(binding_epoch>=0),
 external_chat_id text CHECK(external_chat_id IS NULL OR length(external_chat_id)>0),
 provider_message_id text NOT NULL CHECK(length(provider_message_id) BETWEEN 1 AND 128),
 kind text NOT NULL, status text NOT NULL,
 evidence_key text NOT NULL CHECK(length(evidence_key) BETWEEN 1 AND 128),
 provider_event_key text CHECK(provider_event_key IS NULL OR length(provider_event_key) BETWEEN 1 AND 256),
 occurred_at timestamptz, received_at timestamptz NOT NULL, observed_at timestamptz NOT NULL,
 PRIMARY KEY(company_id,id),
 UNIQUE(company_id,connection_id,binding_epoch,kind,evidence_key),
 FOREIGN KEY(company_id,connection_id,binding_epoch) REFERENCES __SCHEMA__.connection_identities(company_id,connection_id,binding_epoch),
 CHECK((kind='message.delivery_observed' AND status IN ('delivered','failed')) OR (kind='message.read_observed' AND status='read'))
);
CREATE TABLE __SCHEMA__.provider_receipt_links (
 company_id text NOT NULL, evidence_id text NOT NULL,
 conversation_id text NOT NULL CHECK(length(conversation_id) BETWEEN 1 AND 128),
 message_id text NOT NULL CHECK(length(message_id) BETWEEN 1 AND 128),
 operation_id text CHECK(operation_id IS NULL OR length(operation_id) BETWEEN 1 AND 128),
 attempt_id text CHECK(attempt_id IS NULL OR length(attempt_id) BETWEEN 1 AND 128),
 linked_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(company_id,evidence_id),
 CHECK(operation_id IS NULL OR attempt_id IS NOT NULL),
 FOREIGN KEY(company_id,evidence_id) REFERENCES __SCHEMA__.provider_receipt_evidence(company_id,id),
 FOREIGN KEY(company_id,message_id,conversation_id) REFERENCES __SCHEMA__.messages(company_id,id,conversation_id),
 FOREIGN KEY(company_id,operation_id) REFERENCES __SCHEMA__.send_operations(company_id,id),
 FOREIGN KEY(company_id,attempt_id) REFERENCES __SCHEMA__.send_attempts(company_id,id)
);
CREATE INDEX receipt_evidence_lookup ON __SCHEMA__.provider_receipt_evidence(company_id,connection_id,binding_epoch,external_chat_id,provider_message_id);
CREATE INDEX receipt_link_operation ON __SCHEMA__.provider_receipt_links(company_id,operation_id) WHERE operation_id IS NOT NULL;
CREATE INDEX receipt_link_attempt ON __SCHEMA__.provider_receipt_links(company_id,attempt_id) WHERE attempt_id IS NOT NULL;
CREATE FUNCTION __SCHEMA__.reject_receipt_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='immutable_receipt_history'; END $$;
CREATE TRIGGER receipt_evidence_append_only BEFORE UPDATE OR DELETE ON __SCHEMA__.provider_receipt_evidence FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.reject_receipt_history_mutation();
CREATE TRIGGER receipt_links_append_only BEFORE UPDATE OR DELETE ON __SCHEMA__.provider_receipt_links FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.reject_receipt_history_mutation();
CREATE FUNCTION __SCHEMA__.verify_receipt_link() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
 evidence __SCHEMA__.provider_receipt_evidence%ROWTYPE;
 conversation_row __SCHEMA__.conversations%ROWTYPE;
 message_row __SCHEMA__.messages%ROWTYPE;
 attempt_row __SCHEMA__.send_attempts%ROWTYPE;
 operation_row __SCHEMA__.send_operations%ROWTYPE;
BEGIN
 SELECT * INTO evidence FROM __SCHEMA__.provider_receipt_evidence WHERE company_id=NEW.company_id AND id=NEW.evidence_id FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='23503',MESSAGE='receipt_evidence_not_found'; END IF;
 SELECT * INTO conversation_row FROM __SCHEMA__.conversations WHERE company_id=NEW.company_id AND id=NEW.conversation_id FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='23503',MESSAGE='receipt_conversation_not_found'; END IF;
 IF evidence.external_chat_id IS NULL OR conversation_row.connection_id IS DISTINCT FROM evidence.connection_id OR conversation_row.binding_epoch IS DISTINCT FROM evidence.binding_epoch OR conversation_row.external_chat_id IS DISTINCT FROM evidence.external_chat_id THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='receipt_conversation_proof_mismatch'; END IF;
 SELECT * INTO message_row FROM __SCHEMA__.messages WHERE company_id=NEW.company_id AND id=NEW.message_id FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='23503',MESSAGE='receipt_message_not_found'; END IF;
 IF message_row.conversation_id IS DISTINCT FROM NEW.conversation_id OR message_row.provider_message_id IS NULL OR message_row.provider_message_id IS DISTINCT FROM evidence.provider_message_id THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='receipt_message_proof_mismatch'; END IF;
 IF NEW.operation_id IS NOT NULL AND NEW.attempt_id IS NULL THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='receipt_operation_requires_attempt'; END IF;
 IF NEW.attempt_id IS NOT NULL THEN
  SELECT * INTO attempt_row FROM __SCHEMA__.send_attempts WHERE company_id=NEW.company_id AND id=NEW.attempt_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='23503',MESSAGE='receipt_attempt_not_found'; END IF;
  IF (NEW.operation_id IS NOT NULL AND attempt_row.operation_id IS DISTINCT FROM NEW.operation_id) OR attempt_row.provider_message_id IS NULL OR attempt_row.provider_message_id IS DISTINCT FROM evidence.provider_message_id THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='receipt_attempt_proof_mismatch'; END IF;
  -- An attempt-only association must still prove its real operation.
  SELECT * INTO operation_row FROM __SCHEMA__.send_operations WHERE company_id=NEW.company_id AND id=attempt_row.operation_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='23503',MESSAGE='receipt_operation_not_found'; END IF;
  IF operation_row.conversation_id IS DISTINCT FROM NEW.conversation_id OR operation_row.connection_id IS DISTINCT FROM evidence.connection_id OR operation_row.binding_epoch IS DISTINCT FROM evidence.binding_epoch OR operation_row.provider_message_id IS NULL OR operation_row.provider_message_id IS DISTINCT FROM evidence.provider_message_id THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='receipt_operation_proof_mismatch'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER receipt_link_proof BEFORE INSERT ON __SCHEMA__.provider_receipt_links FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.verify_receipt_link();
