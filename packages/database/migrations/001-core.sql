-- Canonical v2 persistence foundation. Applied by the transactional migration runner.
-- __SCHEMA__ is replaced only after strict identifier validation. No external effects.
CREATE FUNCTION __SCHEMA__.reject_identity_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE key text;
BEGIN
  FOREACH key IN ARRAY TG_ARGV LOOP
    IF (to_jsonb(OLD)->key) IS DISTINCT FROM (to_jsonb(NEW)->key) THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='immutable_identity';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;

CREATE TABLE __SCHEMA__.companies (
 id text PRIMARY KEY CHECK(length(id)>0), display_name text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE __SCHEMA__.departments (
 company_id text NOT NULL REFERENCES __SCHEMA__.companies(id), id text NOT NULL CHECK(length(id)>0),
 display_name text, PRIMARY KEY(company_id,id)
);
CREATE TABLE __SCHEMA__.staff (
 company_id text NOT NULL REFERENCES __SCHEMA__.companies(id), id text NOT NULL CHECK(length(id)>0),
 display_name text, capacity integer NOT NULL DEFAULT 0 CHECK(capacity>=0),
 active_count integer NOT NULL DEFAULT 0 CHECK(active_count>=0 AND active_count<=capacity),
 availability text NOT NULL DEFAULT 'offline' CHECK(availability IN ('online','offline','away')),
 version bigint NOT NULL DEFAULT 0 CHECK(version>=0), PRIMARY KEY(company_id,id)
);
CREATE TABLE __SCHEMA__.staff_memberships (
 company_id text NOT NULL, staff_id text NOT NULL, department_id text NOT NULL,
 PRIMARY KEY(company_id,staff_id,department_id),
 FOREIGN KEY(company_id,staff_id) REFERENCES __SCHEMA__.staff(company_id,id),
 FOREIGN KEY(company_id,department_id) REFERENCES __SCHEMA__.departments(company_id,id)
);
CREATE TABLE __SCHEMA__.connections (
 company_id text NOT NULL REFERENCES __SCHEMA__.companies(id), id text NOT NULL CHECK(length(id)>0),
 channel_mode text NOT NULL CHECK(channel_mode IN ('telegram_bot','telegram_personal','telegram_business','whatsapp_cloud','whatsapp_qr','max_bot','vk_community')),
 binding_epoch bigint NOT NULL CHECK(binding_epoch>=0), credentials_version bigint NOT NULL CHECK(credentials_version>=0),
 state text NOT NULL CHECK(state IN ('setup','active','degraded','auth_required','paused','disabled')),
 version bigint NOT NULL CHECK(version>=0), capabilities jsonb NOT NULL CHECK(jsonb_typeof(capabilities)='object'),
 ingress_enabled boolean NOT NULL DEFAULT false, send_enabled boolean NOT NULL DEFAULT false,
 health jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(health)='object'),
 credential_ref text CHECK(credential_ref IS NULL OR length(credential_ref)>0),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(company_id,id)
);
CREATE TABLE __SCHEMA__.connection_identities (
 company_id text NOT NULL, connection_id text NOT NULL, binding_epoch bigint NOT NULL CHECK(binding_epoch>=0),
 external_identity_ref text CHECK(external_identity_ref IS NULL OR length(external_identity_ref)>0),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(company_id,connection_id,binding_epoch),
 FOREIGN KEY(company_id,connection_id) REFERENCES __SCHEMA__.connections(company_id,id)
);
ALTER TABLE __SCHEMA__.connections ADD CONSTRAINT current_connection_identity
 FOREIGN KEY(company_id,id,binding_epoch) REFERENCES __SCHEMA__.connection_identities(company_id,connection_id,binding_epoch)
 DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE __SCHEMA__.conversations (
 company_id text NOT NULL, id text NOT NULL CHECK(length(id)>0), connection_id text NOT NULL, binding_epoch bigint NOT NULL,
 external_chat_id text NOT NULL CHECK(length(external_chat_id)>0),
 chat_kind text NOT NULL DEFAULT 'unknown' CHECK(chat_kind IN ('private','group','unknown')),
 display_name text, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(company_id,id), UNIQUE(company_id,connection_id,binding_epoch,external_chat_id),
 UNIQUE(company_id,id,connection_id,binding_epoch),
 UNIQUE(company_id,id,connection_id,binding_epoch,external_chat_id),
 FOREIGN KEY(company_id,connection_id,binding_epoch) REFERENCES __SCHEMA__.connection_identities(company_id,connection_id,binding_epoch)
);
CREATE TRIGGER immutable_conversation BEFORE UPDATE ON __SCHEMA__.conversations FOR EACH ROW
 EXECUTE FUNCTION __SCHEMA__.reject_identity_change('company_id','id','connection_id','binding_epoch','external_chat_id','chat_kind');
CREATE TABLE __SCHEMA__.messages (
 company_id text NOT NULL, id text NOT NULL CHECK(length(id)>0), conversation_id text NOT NULL,
 direction text NOT NULL CHECK(direction IN ('in','out')), provider_message_id text CHECK(provider_message_id IS NULL OR length(provider_message_id)>0),
 current_content_version bigint NOT NULL CHECK(current_content_version>=0), deleted_at timestamptz,
 provenance text NOT NULL DEFAULT 'live' CHECK(provenance IN ('live','historical_import','reconciliation')),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(company_id,id),
 UNIQUE(company_id,id,conversation_id), UNIQUE(company_id,conversation_id,provider_message_id),
 FOREIGN KEY(company_id,conversation_id) REFERENCES __SCHEMA__.conversations(company_id,id)
);
CREATE TRIGGER immutable_message_address BEFORE UPDATE ON __SCHEMA__.messages FOR EACH ROW
 EXECUTE FUNCTION __SCHEMA__.reject_identity_change('company_id','id','conversation_id','direction','provenance');
CREATE FUNCTION __SCHEMA__.protect_provider_message_id() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.provider_message_id IS NOT NULL AND OLD.provider_message_id IS DISTINCT FROM NEW.provider_message_id THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='immutable_provider_message_id';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_provider_message_id BEFORE UPDATE ON __SCHEMA__.messages FOR EACH ROW
 EXECUTE FUNCTION __SCHEMA__.protect_provider_message_id();
CREATE TABLE __SCHEMA__.message_versions (
 company_id text NOT NULL, message_id text NOT NULL, content_version bigint NOT NULL CHECK(content_version>=0),
 content jsonb NOT NULL CHECK(jsonb_typeof(content)='object'), observed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(company_id,message_id,content_version),
 FOREIGN KEY(company_id,message_id) REFERENCES __SCHEMA__.messages(company_id,id)
);
ALTER TABLE __SCHEMA__.messages ADD CONSTRAINT current_message_version
 FOREIGN KEY(company_id,id,current_content_version) REFERENCES __SCHEMA__.message_versions(company_id,message_id,content_version)
 DEFERRABLE INITIALLY DEFERRED;
CREATE TRIGGER immutable_message_version BEFORE UPDATE ON __SCHEMA__.message_versions FOR EACH ROW
 EXECUTE FUNCTION __SCHEMA__.reject_identity_change('company_id','message_id','content_version','content');
CREATE TABLE __SCHEMA__.work_items (
 company_id text NOT NULL, id text NOT NULL CHECK(length(id)>0), conversation_id text NOT NULL,
 department_id text, owner_id text,
 state text NOT NULL CHECK(state IN ('queued','assigned','in_progress','waiting_customer','resolved','cancelled')),
 assignment_version bigint NOT NULL DEFAULT 0 CHECK(assignment_version>=0),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(company_id,id), UNIQUE(company_id,id,conversation_id),
 FOREIGN KEY(company_id,conversation_id) REFERENCES __SCHEMA__.conversations(company_id,id),
 FOREIGN KEY(company_id,department_id) REFERENCES __SCHEMA__.departments(company_id,id),
 FOREIGN KEY(company_id,owner_id) REFERENCES __SCHEMA__.staff(company_id,id)
);
CREATE UNIQUE INDEX one_active_work_per_conversation ON __SCHEMA__.work_items(company_id,conversation_id)
 WHERE state NOT IN ('resolved','cancelled');
CREATE TRIGGER immutable_work_item BEFORE UPDATE ON __SCHEMA__.work_items FOR EACH ROW
 EXECUTE FUNCTION __SCHEMA__.reject_identity_change('company_id','id','conversation_id');
CREATE TABLE __SCHEMA__.attention_obligations (
 company_id text NOT NULL, id text NOT NULL CHECK(length(id)>0), work_item_id text NOT NULL, conversation_id text NOT NULL,
 message_id text NOT NULL, content_version bigint NOT NULL, attention_seq bigint NOT NULL CHECK(attention_seq>=0),
 state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','covered','cancelled')),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(company_id,id),
 UNIQUE(company_id,conversation_id,attention_seq), UNIQUE(company_id,id,work_item_id,conversation_id,content_version),
 FOREIGN KEY(company_id,work_item_id,conversation_id) REFERENCES __SCHEMA__.work_items(company_id,id,conversation_id),
 FOREIGN KEY(company_id,message_id,conversation_id) REFERENCES __SCHEMA__.messages(company_id,id,conversation_id),
 FOREIGN KEY(company_id,message_id,content_version) REFERENCES __SCHEMA__.message_versions(company_id,message_id,content_version)
);
CREATE TRIGGER immutable_obligation BEFORE UPDATE ON __SCHEMA__.attention_obligations FOR EACH ROW
 EXECUTE FUNCTION __SCHEMA__.reject_identity_change('company_id','id','work_item_id','conversation_id','message_id','content_version','attention_seq');
CREATE TABLE __SCHEMA__.reply_snapshots (
 company_id text NOT NULL, id text NOT NULL CHECK(length(id)>0), work_item_id text NOT NULL, conversation_id text NOT NULL,
 binding_epoch bigint NOT NULL CHECK(binding_epoch>=0), assignment_version bigint NOT NULL CHECK(assignment_version>=0), actor_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz,
 PRIMARY KEY(company_id,id), UNIQUE(company_id,id,work_item_id,conversation_id),
 FOREIGN KEY(company_id,work_item_id,conversation_id) REFERENCES __SCHEMA__.work_items(company_id,id,conversation_id),
 FOREIGN KEY(company_id,actor_id) REFERENCES __SCHEMA__.staff(company_id,id)
);
CREATE TRIGGER immutable_snapshot BEFORE UPDATE ON __SCHEMA__.reply_snapshots FOR EACH ROW
 EXECUTE FUNCTION __SCHEMA__.reject_identity_change('company_id','id','work_item_id','conversation_id','binding_epoch','assignment_version','actor_id');
CREATE TABLE __SCHEMA__.reply_snapshot_items (
 company_id text NOT NULL, snapshot_id text NOT NULL, work_item_id text NOT NULL, conversation_id text NOT NULL,
 obligation_id text NOT NULL, content_version bigint NOT NULL,
 PRIMARY KEY(company_id,snapshot_id,obligation_id,content_version),
 FOREIGN KEY(company_id,snapshot_id,work_item_id,conversation_id) REFERENCES __SCHEMA__.reply_snapshots(company_id,id,work_item_id,conversation_id),
 FOREIGN KEY(company_id,obligation_id,work_item_id,conversation_id,content_version) REFERENCES __SCHEMA__.attention_obligations(company_id,id,work_item_id,conversation_id,content_version)
);
CREATE TABLE __SCHEMA__.send_operations (
 company_id text NOT NULL, id text NOT NULL CHECK(length(id)>0), work_item_id text NOT NULL, conversation_id text NOT NULL,
 connection_id text NOT NULL, binding_epoch bigint NOT NULL, snapshot_id text, actor_id text NOT NULL,
 command_type text NOT NULL CHECK(length(command_type)>0), idempotency_key text NOT NULL CHECK(length(idempotency_key)>0),
 payload_fingerprint text NOT NULL CHECK(payload_fingerprint ~ '^[a-f0-9]{64}$'),
 state text NOT NULL CHECK(state IN ('accepted','queued','dispatching','sent','failed','unknown','cancelled')),
 coverage text NOT NULL DEFAULT 'unconfirmed' CHECK(coverage IN ('unconfirmed','confirmed')),
 content jsonb NOT NULL CHECK(jsonb_typeof(content)='object'), deadline timestamptz NOT NULL,
 provider_message_id text CHECK(provider_message_id IS NULL OR length(provider_message_id)>0),
 version bigint NOT NULL DEFAULT 0 CHECK(version>=0), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(company_id,id), UNIQUE(company_id,command_type,idempotency_key), UNIQUE(company_id,id,work_item_id,conversation_id,state),
 CHECK(coverage<>'confirmed' OR state='sent'),
 FOREIGN KEY(company_id,work_item_id,conversation_id) REFERENCES __SCHEMA__.work_items(company_id,id,conversation_id),
 FOREIGN KEY(company_id,conversation_id,connection_id,binding_epoch) REFERENCES __SCHEMA__.conversations(company_id,id,connection_id,binding_epoch),
 FOREIGN KEY(company_id,snapshot_id,work_item_id,conversation_id) REFERENCES __SCHEMA__.reply_snapshots(company_id,id,work_item_id,conversation_id),
 FOREIGN KEY(company_id,actor_id) REFERENCES __SCHEMA__.staff(company_id,id)
);
CREATE TRIGGER immutable_send_intent BEFORE UPDATE ON __SCHEMA__.send_operations FOR EACH ROW
 EXECUTE FUNCTION __SCHEMA__.reject_identity_change('company_id','id','work_item_id','conversation_id','connection_id','binding_epoch','snapshot_id','actor_id','command_type','idempotency_key','payload_fingerprint','content','deadline');
CREATE TABLE __SCHEMA__.send_attempts (
 company_id text NOT NULL, id text NOT NULL CHECK(length(id)>0), operation_id text NOT NULL,
 attempt_no integer NOT NULL CHECK(attempt_no>0), dispatch_fence bigint NOT NULL CHECK(dispatch_fence>=0),
 state text NOT NULL DEFAULT 'created' CHECK(state IN ('created','dispatching','sent','failed','unknown')),
 provider_message_id text CHECK(provider_message_id IS NULL OR length(provider_message_id)>0),
 started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 PRIMARY KEY(company_id,id), UNIQUE(company_id,operation_id,attempt_no), UNIQUE(company_id,operation_id,id),
 FOREIGN KEY(company_id,operation_id) REFERENCES __SCHEMA__.send_operations(company_id,id)
);
CREATE TABLE __SCHEMA__.send_coverage (
 company_id text NOT NULL, operation_id text NOT NULL, work_item_id text NOT NULL, conversation_id text NOT NULL,
 operation_state text NOT NULL DEFAULT 'sent' CHECK(operation_state='sent'), obligation_id text NOT NULL, content_version bigint NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(company_id,operation_id,obligation_id,content_version),
 FOREIGN KEY(company_id,operation_id,work_item_id,conversation_id,operation_state) REFERENCES __SCHEMA__.send_operations(company_id,id,work_item_id,conversation_id,state),
 FOREIGN KEY(company_id,obligation_id,work_item_id,conversation_id,content_version) REFERENCES __SCHEMA__.attention_obligations(company_id,id,work_item_id,conversation_id,content_version)
);
CREATE TABLE __SCHEMA__.inbox_events (
 company_id text NOT NULL, id text NOT NULL CHECK(length(id)>0), connection_id text NOT NULL, binding_epoch bigint NOT NULL,
 provider_event_key text CHECK(provider_event_key IS NULL OR length(provider_event_key)>0), payload_major integer NOT NULL CHECK(payload_major=2),
 kind text NOT NULL CHECK(length(kind)>0), payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
 provenance text NOT NULL DEFAULT 'live' CHECK(provenance IN ('live','historical_import','reconciliation')),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processing','processed','failed','quarantined')),
 occurred_at timestamptz, received_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz,
 PRIMARY KEY(company_id,id),
 FOREIGN KEY(company_id,connection_id,binding_epoch) REFERENCES __SCHEMA__.connection_identities(company_id,connection_id,binding_epoch)
);
CREATE UNIQUE INDEX inbox_provider_key ON __SCHEMA__.inbox_events(company_id,connection_id,binding_epoch,provider_event_key) WHERE provider_event_key IS NOT NULL;
CREATE TABLE __SCHEMA__.outbox_jobs (
 company_id text NOT NULL REFERENCES __SCHEMA__.companies(id), id text NOT NULL CHECK(length(id)>0),
 job_kind text NOT NULL CHECK(length(job_kind)>0), intent_key text NOT NULL CHECK(length(intent_key)>0), payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','leased','completed','failed','unknown','cancelled')),
 lease_owner text, lease_until timestamptz, fence bigint NOT NULL DEFAULT 0 CHECK(fence>=0), attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
 available_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(company_id,id), UNIQUE(company_id,job_kind,intent_key),
 CHECK(state<>'leased' OR (lease_owner IS NOT NULL AND length(lease_owner)>0 AND lease_until IS NOT NULL))
);
CREATE INDEX outbox_dispatch ON __SCHEMA__.outbox_jobs(company_id,state,available_at);
CREATE TABLE __SCHEMA__.audit_events (
 company_id text NOT NULL REFERENCES __SCHEMA__.companies(id), id text NOT NULL CHECK(length(id)>0),
 event_name text NOT NULL CHECK(length(event_name)>0), subject_id text NOT NULL CHECK(length(subject_id)>0),
 actor_id text, trace_id text, diagnostic_code text, recorded_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(company_id,id), FOREIGN KEY(company_id,actor_id) REFERENCES __SCHEMA__.staff(company_id,id)
);
CREATE TABLE __SCHEMA__.crm_accounts (
 company_id text NOT NULL REFERENCES __SCHEMA__.companies(id), id text NOT NULL CHECK(length(id)>0),
 external_account_id text CHECK(external_account_id IS NULL OR length(external_account_id)>0), credential_ref text,
 state text NOT NULL DEFAULT 'setup' CHECK(state IN ('setup','active','disabled','revoked')),
 version bigint NOT NULL DEFAULT 0 CHECK(version>=0), PRIMARY KEY(company_id,id)
);
CREATE TABLE __SCHEMA__.crm_bindings (
 company_id text NOT NULL, id text NOT NULL CHECK(length(id)>0), account_id text NOT NULL, conversation_id text NOT NULL,
 state text NOT NULL CHECK(state IN ('pending','bound','creation_unknown','disabled')),
 contact_id text CHECK(contact_id IS NULL OR length(contact_id)>0), chat_id text CHECK(chat_id IS NULL OR length(chat_id)>0),
 lead_id text CHECK(lead_id IS NULL OR length(lead_id)>0), version bigint NOT NULL DEFAULT 0 CHECK(version>=0),
 PRIMARY KEY(company_id,id), UNIQUE(company_id,account_id,conversation_id),
 CHECK(state<>'bound' OR (contact_id IS NOT NULL AND chat_id IS NOT NULL)),
 FOREIGN KEY(company_id,account_id) REFERENCES __SCHEMA__.crm_accounts(company_id,id),
 FOREIGN KEY(company_id,conversation_id) REFERENCES __SCHEMA__.conversations(company_id,id)
);
CREATE TABLE __SCHEMA__.crm_create_intents (
 company_id text NOT NULL, id text NOT NULL CHECK(length(id)>0), account_id text NOT NULL, conversation_id text NOT NULL,
 intent_key text NOT NULL CHECK(length(intent_key)>0), entity_kind text NOT NULL CHECK(entity_kind IN ('contact','lead','chat')),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','dispatching','created','failed','creation_unknown','cancelled')),
 external_id text CHECK(external_id IS NULL OR length(external_id)>0), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(company_id,id), UNIQUE(company_id,account_id,entity_kind,intent_key),
 CHECK(state<>'created' OR external_id IS NOT NULL),
 FOREIGN KEY(company_id,account_id) REFERENCES __SCHEMA__.crm_accounts(company_id,id),
 FOREIGN KEY(company_id,conversation_id) REFERENCES __SCHEMA__.conversations(company_id,id)
);
CREATE TABLE __SCHEMA__.media_assets (
 company_id text NOT NULL REFERENCES __SCHEMA__.companies(id), id text NOT NULL CHECK(length(id)>0),
 state text NOT NULL DEFAULT 'pending_upload' CHECK(state IN ('pending_upload','quarantined','ready','rejected')),
 storage_key text CHECK(storage_key IS NULL OR length(storage_key)>0), reservation_id text CHECK(reservation_id IS NULL OR length(reservation_id)>0),
 expires_at timestamptz, mime_type text, byte_size bigint CHECK(byte_size>=0), sha256 text CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(company_id,id), UNIQUE(company_id,reservation_id),
 CHECK(state<>'ready' OR (storage_key IS NOT NULL AND byte_size IS NOT NULL AND sha256 IS NOT NULL))
);
CREATE TABLE __SCHEMA__.consents (
 company_id text NOT NULL, id text NOT NULL CHECK(length(id)>0), conversation_id text NOT NULL,
 purpose text NOT NULL CHECK(length(purpose)>0), state text NOT NULL CHECK(state IN ('granted','revoked','unknown')),
 evidence_ref text CHECK(evidence_ref IS NULL OR length(evidence_ref)>0), observed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(company_id,id), FOREIGN KEY(company_id,conversation_id) REFERENCES __SCHEMA__.conversations(company_id,id)
);

-- Business routing, restrictive channel policy, and private archive references.
CREATE TABLE __SCHEMA__.workshops (
 company_id text NOT NULL REFERENCES __SCHEMA__.companies(id), id text NOT NULL CHECK(length(id)>0),
 display_name text, PRIMARY KEY(company_id,id)
);
CREATE TABLE __SCHEMA__.crm_sources (
 company_id text NOT NULL, id text NOT NULL CHECK(length(id)>0), account_id text NOT NULL,
 external_id text NOT NULL CHECK(length(external_id)>0), origin_code text NOT NULL CHECK(length(origin_code)>0),
 source_kind text NOT NULL DEFAULT 'technical_chat' CHECK(source_kind='technical_chat'),
 PRIMARY KEY(company_id,id), UNIQUE(company_id,account_id,id), UNIQUE(company_id,account_id,external_id),
 FOREIGN KEY(company_id,account_id) REFERENCES __SCHEMA__.crm_accounts(company_id,id)
);
CREATE TABLE __SCHEMA__.connection_routes (
 company_id text NOT NULL, connection_id text NOT NULL, workshop_id text NOT NULL, crm_account_id text NOT NULL,
 funnel_id text NOT NULL CHECK(length(funnel_id)>0), default_owner_id text NOT NULL, technical_source_id text NOT NULL,
 version bigint NOT NULL CHECK(version>=0), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(company_id,connection_id),
 FOREIGN KEY(company_id,connection_id) REFERENCES __SCHEMA__.connections(company_id,id),
 FOREIGN KEY(company_id,workshop_id) REFERENCES __SCHEMA__.workshops(company_id,id),
 FOREIGN KEY(company_id,crm_account_id) REFERENCES __SCHEMA__.crm_accounts(company_id,id),
 FOREIGN KEY(company_id,default_owner_id) REFERENCES __SCHEMA__.staff(company_id,id),
 FOREIGN KEY(company_id,crm_account_id,technical_source_id) REFERENCES __SCHEMA__.crm_sources(company_id,account_id,id)
);
CREATE TABLE __SCHEMA__.channel_permissions (
 company_id text NOT NULL, connection_id text NOT NULL, staff_id text NOT NULL,
 can_read boolean NOT NULL DEFAULT false, can_send boolean NOT NULL DEFAULT false,
 version bigint NOT NULL DEFAULT 0 CHECK(version>=0), PRIMARY KEY(company_id,connection_id,staff_id),
 FOREIGN KEY(company_id,connection_id) REFERENCES __SCHEMA__.connections(company_id,id),
 FOREIGN KEY(company_id,staff_id) REFERENCES __SCHEMA__.staff(company_id,id)
);
CREATE TABLE __SCHEMA__.channel_policies (
 company_id text NOT NULL, connection_id text NOT NULL,
 crm_projection_enabled boolean NOT NULL DEFAULT false, private_import_enabled boolean NOT NULL DEFAULT true,
 group_default text NOT NULL DEFAULT 'deny' CHECK(group_default='deny'),
 group_send_enabled boolean NOT NULL DEFAULT false, group_delete_enabled boolean NOT NULL DEFAULT false,
 version bigint NOT NULL DEFAULT 0 CHECK(version>=0), PRIMARY KEY(company_id,connection_id),
 FOREIGN KEY(company_id,connection_id) REFERENCES __SCHEMA__.connections(company_id,id)
);
CREATE TABLE __SCHEMA__.channel_group_rules (
 company_id text NOT NULL, connection_id text NOT NULL, binding_epoch bigint NOT NULL,
 external_chat_id text NOT NULL CHECK(length(external_chat_id)>0),
 decision text NOT NULL CHECK(decision IN ('allow_crm','exclude','archive_only')),
 display_name text, version bigint NOT NULL DEFAULT 0 CHECK(version>=0),
 PRIMARY KEY(company_id,connection_id,binding_epoch,external_chat_id),
 FOREIGN KEY(company_id,connection_id,binding_epoch) REFERENCES __SCHEMA__.connection_identities(company_id,connection_id,binding_epoch)
);
CREATE TRIGGER immutable_group_identity BEFORE UPDATE ON __SCHEMA__.channel_group_rules FOR EACH ROW
 EXECUTE FUNCTION __SCHEMA__.reject_identity_change('company_id','connection_id','binding_epoch','external_chat_id');
-- No privileged execution and no implicit search_path. Caller still must apply the gate before any CRM effect.
CREATE FUNCTION __SCHEMA__.channel_crm_import_allowed(p_company text,p_connection text,p_epoch bigint,p_chat text,p_kind text)
 RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER AS $$
 SELECT COALESCE((SELECT p.crm_projection_enabled AND EXISTS (
   SELECT 1 FROM __SCHEMA__.connection_identities i WHERE i.company_id=p_company AND i.connection_id=p_connection AND i.binding_epoch=p_epoch
 ) AND CASE p_kind
   WHEN 'private' THEN p.private_import_enabled
   WHEN 'group' THEN EXISTS (SELECT 1 FROM __SCHEMA__.channel_group_rules r
      WHERE r.company_id=p_company AND r.connection_id=p_connection AND r.binding_epoch=p_epoch
       AND r.external_chat_id=p_chat AND r.decision='allow_crm')
   ELSE false END
 FROM __SCHEMA__.channel_policies p WHERE p.company_id=p_company AND p.connection_id=p_connection),false)
$$;
CREATE TABLE __SCHEMA__.attachments (
 company_id text NOT NULL, id text NOT NULL CHECK(length(id)>0), message_id text NOT NULL, conversation_id text NOT NULL,
 connection_id text NOT NULL, binding_epoch bigint NOT NULL, external_chat_id text NOT NULL CHECK(length(external_chat_id)>0),
 external_message_id text CHECK(external_message_id IS NULL OR length(external_message_id)>0),
 amo_chat_id text CHECK(amo_chat_id IS NULL OR length(amo_chat_id)>0), amo_message_id text CHECK(amo_message_id IS NULL OR length(amo_message_id)>0),
 contact_id text CHECK(contact_id IS NULL OR length(contact_id)>0),
 s3_key text CHECK(s3_key IS NULL OR length(s3_key)>0), original_name text NOT NULL CHECK(length(original_name)>0),
 mime_type text NOT NULL CHECK(length(mime_type)>0), byte_size bigint NOT NULL CHECK(byte_size>=0), sha256 text CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 storage_state text NOT NULL DEFAULT 'pending' CHECK(storage_state IN ('pending','stored','verified','failed')),
 archive_status text NOT NULL DEFAULT 'pending' CHECK(archive_status IN ('pending','index_pending','indexed','unknown','failed')),
 index_ack_ref text CHECK(index_ack_ref IS NULL OR length(index_ack_ref)>0),
 group_archive_only boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(company_id,id),
 CHECK(storage_state NOT IN ('stored','verified') OR s3_key IS NOT NULL),
 CHECK(storage_state<>'verified' OR sha256 IS NOT NULL),
 CHECK(archive_status<>'indexed' OR (storage_state='verified' AND s3_key IS NOT NULL AND sha256 IS NOT NULL AND index_ack_ref IS NOT NULL)),
 CHECK(NOT group_archive_only OR (amo_chat_id IS NULL AND amo_message_id IS NULL AND contact_id IS NULL)),
 FOREIGN KEY(company_id,message_id,conversation_id) REFERENCES __SCHEMA__.messages(company_id,id,conversation_id),
 FOREIGN KEY(company_id,conversation_id,connection_id,binding_epoch,external_chat_id) REFERENCES __SCHEMA__.conversations(company_id,id,connection_id,binding_epoch,external_chat_id)
);
CREATE TRIGGER immutable_attachment_origin BEFORE UPDATE ON __SCHEMA__.attachments FOR EACH ROW
 EXECUTE FUNCTION __SCHEMA__.reject_identity_change('company_id','id','message_id','conversation_id','connection_id','binding_epoch','external_chat_id','external_message_id');
CREATE TABLE __SCHEMA__.attachment_lead_links (
 company_id text NOT NULL, attachment_id text NOT NULL, account_id text NOT NULL, lead_id text NOT NULL CHECK(length(lead_id)>0),
 link_state text NOT NULL DEFAULT 'active' CHECK(link_state IN ('active','deleted','merged')),
 merged_into_lead_id text CHECK(merged_into_lead_id IS NULL OR length(merged_into_lead_id)>0),
 observed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(company_id,attachment_id,account_id,lead_id),
 CHECK(link_state<>'merged' OR merged_into_lead_id IS NOT NULL),
 FOREIGN KEY(company_id,attachment_id) REFERENCES __SCHEMA__.attachments(company_id,id),
 FOREIGN KEY(company_id,account_id) REFERENCES __SCHEMA__.crm_accounts(company_id,id)
);
CREATE TABLE __SCHEMA__.archive_handoff_jobs (
 company_id text NOT NULL, id text NOT NULL CHECK(length(id)>0), attachment_id text NOT NULL,
 intent_key text NOT NULL CHECK(length(intent_key)>0), delivery_enabled boolean NOT NULL DEFAULT false,
 contract_ref text CHECK(contract_ref IS NULL OR length(contract_ref)>0),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','leased','indexed','failed','unknown','cancelled')),
 lease_owner text, lease_until timestamptz, fence bigint NOT NULL DEFAULT 0 CHECK(fence>=0),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(company_id,id), UNIQUE(company_id,intent_key),
 CHECK(NOT delivery_enabled OR contract_ref IS NOT NULL),
 CHECK(state<>'leased' OR (delivery_enabled AND lease_owner IS NOT NULL AND length(lease_owner)>0 AND lease_until IS NOT NULL)),
 FOREIGN KEY(company_id,attachment_id) REFERENCES __SCHEMA__.attachments(company_id,id)
);
CREATE TABLE __SCHEMA__.conversation_leads (
 company_id text NOT NULL, id text NOT NULL CHECK(length(id)>0), account_id text NOT NULL, conversation_id text NOT NULL,
 lead_id text NOT NULL CHECK(length(lead_id)>0), link_state text NOT NULL DEFAULT 'active' CHECK(link_state IN ('active','deleted','merged')),
 merged_into_lead_id text CHECK(merged_into_lead_id IS NULL OR length(merged_into_lead_id)>0), observed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(company_id,id), UNIQUE(company_id,account_id,conversation_id,lead_id),
 CHECK(link_state<>'merged' OR merged_into_lead_id IS NOT NULL),
 FOREIGN KEY(company_id,account_id) REFERENCES __SCHEMA__.crm_accounts(company_id,id),
 FOREIGN KEY(company_id,conversation_id) REFERENCES __SCHEMA__.conversations(company_id,id)
);
CREATE TABLE __SCHEMA__.cleanup_policies (
 company_id text PRIMARY KEY REFERENCES __SCHEMA__.companies(id),
 crm_cleanup_enabled boolean NOT NULL DEFAULT false CHECK(NOT crm_cleanup_enabled),
 messenger_cleanup_enabled boolean NOT NULL DEFAULT false CHECK(NOT messenger_cleanup_enabled),
 archive_cleanup_enabled boolean NOT NULL DEFAULT false CHECK(NOT archive_cleanup_enabled)
);
CREATE TABLE __SCHEMA__.crm_entity_tombstones (
 company_id text NOT NULL, account_id text NOT NULL, entity_type text NOT NULL CHECK(entity_type IN ('contact','lead','chat','message')),
 external_id text NOT NULL CHECK(length(external_id)>0),
 observation text NOT NULL DEFAULT 'deleted' CHECK(observation IN ('deleted','merged')),
 replacement_external_id text CHECK(replacement_external_id IS NULL OR length(replacement_external_id)>0),
 observed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(company_id,account_id,entity_type,external_id),
 CHECK(observation<>'merged' OR replacement_external_id IS NOT NULL),
 FOREIGN KEY(company_id,account_id) REFERENCES __SCHEMA__.crm_accounts(company_id,id)
);
-- All FKs deliberately retain the default NO ACTION; CRM observations cannot cascade-delete provider/archive originals.
