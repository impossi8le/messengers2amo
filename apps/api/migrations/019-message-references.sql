-- Preserve original CRM identity while recording confirmed provider ids separately.
ALTER TABLE __SCHEMA__.amocrm_message_links
 ADD COLUMN message_id text,
 ADD COLUMN operation_id text,
 ADD COLUMN actual_provider_message_id text,
 ADD CONSTRAINT amocrm_link_message_fk FOREIGN KEY(company_id,message_id) REFERENCES __SCHEMA__.messages(company_id,id),
 ADD CONSTRAINT amocrm_link_operation_fk FOREIGN KEY(company_id,operation_id) REFERENCES __SCHEMA__.send_operations(company_id,id),
 ADD CONSTRAINT amocrm_outgoing_operation CHECK(operation_id IS NULL OR direction='out');

UPDATE __SCHEMA__.amocrm_message_links l SET message_id=m.id,actual_provider_message_id=m.provider_message_id
 FROM __SCHEMA__.messages m WHERE m.company_id=l.company_id AND m.conversation_id=l.conversation_id
 AND m.direction=l.direction AND m.provider_message_id=l.provider_message_id AND l.provider_message_id NOT LIKE 'crm:%';

UPDATE __SCHEMA__.amocrm_message_links l SET operation_id=o.id
 FROM __SCHEMA__.send_operations o WHERE l.direction='out' AND o.company_id=l.company_id
 AND o.conversation_id=l.conversation_id AND o.command_type='crm.reply'
 AND o.idempotency_key='amocrm:'||l.account_id||':'||l.amo_message_id;

UPDATE __SCHEMA__.amocrm_message_links l SET actual_provider_message_id=o.provider_message_id,message_id=m.id
 FROM __SCHEMA__.send_operations o JOIN __SCHEMA__.messages m ON m.company_id=o.company_id
 AND m.conversation_id=o.conversation_id AND m.direction='out' AND m.provider_message_id=o.provider_message_id
 WHERE l.company_id=o.company_id AND l.operation_id=o.id AND o.state='sent' AND o.provider_message_id IS NOT NULL;

CREATE UNIQUE INDEX amocrm_link_operation ON __SCHEMA__.amocrm_message_links(company_id,operation_id) WHERE operation_id IS NOT NULL;
CREATE UNIQUE INDEX amocrm_link_actual_provider ON __SCHEMA__.amocrm_message_links(company_id,account_id,conversation_id,actual_provider_message_id) WHERE actual_provider_message_id IS NOT NULL;
