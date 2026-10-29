-- Synthetic scale fixture for the RTO rehearsal. No personal data, no provider
-- credentials, nothing is sent anywhere: this only fills a throwaway database
-- that was created from a schema-only dump of production.
--
-- Run against an EMPTY schema (see BACKUP-RESTORE.md §4):
--   psql -U messengers2amo -d m2a_rto_scale -v ON_ERROR_STOP=1 \
--        -f seed-restore-scale.sql
--
-- Volumes (defaults): 20 000 conversations, 200 000 messages,
-- 50 000 work items, 100 000 inbox events, 30 000 send operations.
-- Override with -v conversations=... etc. Ids are deterministic.

\if :{?conversations}
\else
  \set conversations 20000
\endif
\if :{?messages}
\else
  \set messages 200000
\endif
\if :{?work_items}
\else
  \set work_items 50000
\endif
\if :{?inbox_events}
\else
  \set inbox_events 100000
\endif
\if :{?send_operations}
\else
  \set send_operations 30000
\endif

BEGIN;
SET LOCAL synchronous_commit = off;
SET LOCAL maintenance_work_mem = '256MB';

INSERT INTO companies(id, display_name)
SELECT 'scale_co_'||n, 'Synthetic company '||n FROM generate_series(1,5) n;

INSERT INTO staff(company_id, id, display_name, capacity, availability)
SELECT c.id, 'op_'||n, 'Synthetic operator '||n, 50, 'online'
FROM companies c CROSS JOIN generate_series(1,10) n;

INSERT INTO departments(company_id, id, display_name)
SELECT c.id, 'dept_'||n, 'Synthetic department '||n
FROM companies c CROSS JOIN generate_series(1,3) n;

-- connections -> connection_identities is deferrable, the reverse edge is not,
-- so the connection row goes first inside this transaction.
INSERT INTO connections(company_id, id, channel_mode, binding_epoch, credentials_version,
                        state, version, capabilities, ingress_enabled, send_enabled)
SELECT c.id, 'conn_'||n, 'telegram_bot', 0, 1, 'active', 0, '{}', true, true
FROM companies c CROSS JOIN generate_series(1,4) n;

INSERT INTO connection_identities(company_id, connection_id, binding_epoch)
SELECT c.id, 'conn_'||n, 0 FROM companies c CROSS JOIN generate_series(1,4) n;

INSERT INTO conversations(company_id, id, connection_id, binding_epoch, external_chat_id,
                          chat_kind, display_name, created_at)
SELECT k.company_id, 'conv_'||lpad(g::text,7,'0'), k.id, 0, 'chat_'||g, 'private',
       'Synthetic customer '||g, now() - (g % 90000) * interval '1 minute'
FROM generate_series(1, :conversations) g
JOIN (SELECT company_id, id, row_number() OVER (ORDER BY company_id, id) rn FROM connections) k
  ON k.rn = ((g - 1) % (SELECT count(*) FROM connections)) + 1;

INSERT INTO messages(company_id, id, conversation_id, direction, provider_message_id,
                     current_content_version, created_at)
SELECT c.company_id, 'msg_'||lpad(g::text,8,'0'), c.id,
       CASE WHEN g % 3 = 0 THEN 'out' ELSE 'in' END, 'pm_'||g, 0,
       now() - (g % 100000) * interval '1 minute'
FROM generate_series(1, :messages) g
JOIN (SELECT company_id, id, row_number() OVER (ORDER BY company_id, id) rn FROM conversations) c
  ON c.rn = ((g - 1) % :conversations) + 1;

INSERT INTO message_versions(company_id, message_id, content_version, content)
SELECT company_id, id, 0,
       jsonb_build_object('type', 'text', 'text',
         'Synthetic message body '||id||' '||repeat('lorem ipsum dolor sit amet ', 8))
FROM messages;

-- one_active_work_per_conversation allows a single non-terminal work item per
-- conversation, so only the first slice (g <= conversations) is ever active.
INSERT INTO work_items(company_id, id, conversation_id, department_id, owner_id, state,
                       assignment_version, created_at)
SELECT c.company_id, 'wi_'||lpad(g::text,7,'0'), c.id, 'dept_'||(1 + g % 3),
       'op_'||(1 + g % 10),
       CASE WHEN g > :conversations THEN (CASE WHEN g % 2 = 0 THEN 'resolved' ELSE 'cancelled' END)
            ELSE (CASE g % 6 WHEN 0 THEN 'queued' WHEN 1 THEN 'assigned' WHEN 2 THEN 'in_progress'
                             WHEN 3 THEN 'waiting_customer' WHEN 4 THEN 'resolved'
                             ELSE 'cancelled' END)
       END,
       0, now() - (g % 60000) * interval '1 minute'
FROM generate_series(1, :work_items) g
JOIN (SELECT company_id, id, row_number() OVER (ORDER BY company_id, id) rn FROM conversations) c
  ON c.rn = ((g - 1) % :conversations) + 1;

INSERT INTO inbox_events(company_id, id, connection_id, binding_epoch, provider_event_key,
                         payload_major, kind, payload, state, occurred_at)
SELECT m.company_id, 'evt_'||lpad(g::text,7,'0'), cv.connection_id, cv.binding_epoch,
       'pek_'||g, 2, 'message',
       jsonb_build_object('text',
         'Synthetic incoming payload '||g||' '||repeat('abc ', 30),
         'messageId', m.id),
       CASE WHEN g % 10 = 0 THEN 'pending' ELSE 'processed' END,
       now() - (g % 100000) * interval '1 minute'
FROM generate_series(1, :inbox_events) g
JOIN (SELECT company_id, id, conversation_id, row_number() OVER (ORDER BY company_id, id) rn
      FROM messages) m ON m.rn = ((g - 1) % :messages) + 1
JOIN conversations cv ON cv.company_id = m.company_id AND cv.id = m.conversation_id;

INSERT INTO send_operations(company_id, id, work_item_id, conversation_id, connection_id,
                            binding_epoch, snapshot_id, actor_id, command_type,
                            idempotency_key, payload_fingerprint, state, coverage, content,
                            deadline, created_at)
SELECT w.company_id, 'sop_'||lpad(g::text,7,'0'), w.id, w.conversation_id, cv.connection_id,
       cv.binding_epoch, NULL, 'op_'||(1 + g % 10), 'reply', 'idem_'||g,
       md5('fp1:'||g) || md5('fp2:'||g),
       CASE WHEN g % 17 = 0 THEN 'unknown' WHEN g % 3 = 0 THEN 'sent' ELSE 'queued' END,
       'unconfirmed',
       jsonb_build_object('type', 'text', 'text',
         'Synthetic reply '||g||' '||repeat('ok ', 20)),
       now() + interval '1 hour', now() - (g % 50000) * interval '1 minute'
FROM generate_series(1, :send_operations) g
JOIN (SELECT company_id, id, conversation_id, row_number() OVER (ORDER BY company_id, id) rn
      FROM work_items) w ON w.rn = ((g - 1) % :work_items) + 1
JOIN conversations cv ON cv.company_id = w.company_id AND cv.id = w.conversation_id;

INSERT INTO send_attempts(company_id, id, operation_id, attempt_no, dispatch_fence, state, completed_at)
SELECT company_id, 'att_'||id, id, 1, 0, 'unknown', now()
FROM send_operations WHERE state = 'unknown';

INSERT INTO outbox_jobs(company_id, id, job_kind, intent_key, payload, state)
SELECT company_id, 'job_'||id, 'send', id, jsonb_build_object('operationId', id),
       CASE state WHEN 'unknown' THEN 'unknown' WHEN 'sent' THEN 'completed' ELSE 'pending' END
FROM send_operations;

COMMIT;
ANALYZE;
