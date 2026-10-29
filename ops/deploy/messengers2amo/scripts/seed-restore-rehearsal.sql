-- Synthetic fixture; run only via seed-restore-rehearsal.mjs in its new schema.
INSERT INTO companies(id,display_name)
SELECT 'company_'||n,'Rehearsal company '||n FROM generate_series(1,3) n;
INSERT INTO staff(company_id,id,display_name)
SELECT id,'operator','Synthetic operator' FROM companies;
INSERT INTO connections(company_id,id,channel_mode,binding_epoch,credentials_version,state,version,capabilities,ingress_enabled,send_enabled)
SELECT c.id,'connection_'||n,'telegram_bot',0,1,'paused',0,'{}',false,false
FROM companies c CROSS JOIN generate_series(1,2) n;
INSERT INTO connection_identities(company_id,connection_id,binding_epoch)
SELECT company_id,id,0 FROM connections;
INSERT INTO conversations(company_id,id,connection_id,binding_epoch,external_chat_id,chat_kind,display_name)
SELECT company_id,c.id||'_chat_'||n,c.id,0,'synthetic_chat_'||n,'private','Synthetic customer '||n
FROM connections c CROSS JOIN generate_series(1,10) n;
INSERT INTO messages(company_id,id,conversation_id,direction,provider_message_id,current_content_version,created_at)
SELECT company_id,id||'_message_'||n,id,CASE WHEN n%3=0 THEN 'out' ELSE 'in' END,
       'synthetic_message_'||n,0,now()-n*interval '1 minute'
FROM conversations CROSS JOIN generate_series(1,100) n;
INSERT INTO message_versions(company_id,message_id,content_version,content)
SELECT company_id,id,0,jsonb_build_object('type','text','text',repeat('Synthetic restore rehearsal message. ',20)) FROM messages;
INSERT INTO work_items(company_id,id,conversation_id,owner_id,state)
SELECT company_id,id||'_work',id,'operator','in_progress' FROM conversations;
INSERT INTO attention_obligations(company_id,id,work_item_id,conversation_id,message_id,content_version,attention_seq)
SELECT company_id,id||'_obligation',id||'_work',id,id||'_message_100',0,1 FROM conversations;
INSERT INTO reply_snapshots(company_id,id,work_item_id,conversation_id,binding_epoch,assignment_version,actor_id)
SELECT company_id,id||'_snapshot',id||'_work',id,0,0,'operator' FROM conversations;
INSERT INTO reply_snapshot_items(company_id,snapshot_id,work_item_id,conversation_id,obligation_id,content_version)
SELECT company_id,id||'_snapshot',id||'_work',id,id||'_obligation',0 FROM conversations;
INSERT INTO send_operations(company_id,id,work_item_id,conversation_id,connection_id,binding_epoch,snapshot_id,actor_id,command_type,idempotency_key,payload_fingerprint,state,content,deadline)
SELECT company_id,id||'_send',id||'_work',id,connection_id,0,id||'_snapshot','operator','reply',id||'_key',repeat('a',64),
       CASE WHEN id LIKE '%_1' OR id LIKE '%_2' OR id LIKE '%_3' THEN 'unknown' ELSE 'queued' END,
       '{"type":"text","text":"Synthetic reply; never dispatch"}',now()+interval '1 hour'
FROM conversations;
INSERT INTO send_attempts(company_id,id,operation_id,attempt_no,dispatch_fence,state,completed_at)
SELECT company_id,id||'_attempt',id,1,0,'unknown',now() FROM send_operations WHERE state='unknown';
INSERT INTO inbox_events(company_id,id,connection_id,binding_epoch,provider_event_key,payload_major,kind,payload,state)
SELECT m.company_id,m.id||'_event',c.connection_id,0,m.id,2,'message',
       jsonb_build_object('text',repeat('Synthetic incoming payload. ',20),'messageId',m.id),
       CASE WHEN m.id LIKE '%_100' THEN 'pending' ELSE 'processed' END
FROM messages m JOIN conversations c ON c.company_id=m.company_id AND c.id=m.conversation_id;
INSERT INTO outbox_jobs(company_id,id,job_kind,intent_key,payload,state)
SELECT company_id,id||'_job','send',id,jsonb_build_object('operationId',id),
       CASE WHEN state='unknown' THEN 'unknown' ELSE 'pending' END FROM send_operations;
INSERT INTO audit_events(company_id,id,event_name,subject_id,actor_id)
SELECT company_id,id||'_audit','rehearsal.synthetic.message',id,'operator' FROM messages;
