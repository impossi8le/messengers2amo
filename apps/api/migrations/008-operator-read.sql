-- Operator read paths and manual coverage provenance.
-- Storage only: authorization and command rules live in src/operator.

-- A manual coverage decision always carries a human reason. The column is
-- nullable because automatic coverage (confirmed external send) has none.
ALTER TABLE __SCHEMA__.send_coverage
 ADD COLUMN reason text CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 1000);

-- Message history is read per conversation in insertion order; the cursor is a
-- keyset on (created_at, id) so a page cannot skip or repeat a message.
CREATE INDEX messages_by_conversation
 ON __SCHEMA__.messages(company_id, conversation_id, created_at, id);

-- Message -> SendOperation linkage for outbound history. Provider message ids are
-- only unique per conversation, so the join must be conversation-scoped.
CREATE INDEX send_operations_provider_message
 ON __SCHEMA__.send_operations(company_id, conversation_id, provider_message_id)
 WHERE provider_message_id IS NOT NULL;

-- Work item list ordering and workshop scope lookup.
CREATE INDEX work_items_by_id ON __SCHEMA__.work_items(company_id, id);
