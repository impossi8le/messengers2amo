// The projection queue carries an untyped jsonb payload. This module turns that
// payload into exactly one AmocrmSync call, and refuses anything it cannot map:
// a job whose payload is wrong must fail loudly instead of being retried into a
// successful no-op that hides lost messages.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AmocrmApiError } from '../src/integrations/amocrm/client.ts';
import {
  buildMessageJob,
  createProjectionDispatcher,
  type ProjectionSync,
} from '../src/integrations/amocrm/projection.ts';

type Recorded = { method: 'message' | 'event'; input: Record<string, unknown> };

function recorder(): { sync: ProjectionSync; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const sync: ProjectionSync = {
    async projectInboundMessage(input) {
      calls.push({ method: 'message', input: input as unknown as Record<string, unknown> });
      return { projected: true, bindingId: 'b1', contactId: '42', leadId: '9' };
    },
    async applyCrmEvent(input) {
      calls.push({ method: 'event', input: input as unknown as Record<string, unknown> });
      return { action: 'applied' };
    },
  };
  return { sync, calls };
}

const messagePayload = {
  op: 'message',
  companyId: 'c1',
  accountId: 'acc1',
  conversationId: 'conv1',
  providerMessageId: 'msg-1',
  direction: 'in',
  text: 'Здравствуйте',
  phone: '+79991234567',
};

test('a message job is projected and its result is handed back to the queue', async () => {
  const { sync, calls } = recorder();
  const dispatch = createProjectionDispatcher({ sync });

  const result = await dispatch(messagePayload);

  assert.deepEqual(result, { projected: true, bindingId: 'b1', contactId: '42', leadId: '9' });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.input, {
    companyId: 'c1',
    accountId: 'acc1',
    conversationId: 'conv1',
    providerMessageId: 'msg-1',
    direction: 'in',
    text: 'Здравствуйте',
    phone: '+79991234567',
  });
});

test('an occurredAt timestamp is handed to the domain as a Date', async () => {
  const { sync, calls } = recorder();

  await createProjectionDispatcher({ sync })({ ...messagePayload, occurredAt: '2026-10-26T10:00:00.000Z' });

  assert.ok(calls[0]!.input.occurredAt instanceof Date);
  assert.equal((calls[0]!.input.occurredAt as Date).toISOString(), '2026-10-26T10:00:00.000Z');
});

test('an event job is applied as a CRM event', async () => {
  const { sync, calls } = recorder();

  const result = await createProjectionDispatcher({ sync })({
    op: 'event',
    companyId: 'c1',
    accountId: 'acc1',
    kind: 'contact.updated',
    payload: { id: 42 },
  });

  assert.deepEqual(result, { action: 'applied' });
  assert.deepEqual(calls[0], {
    method: 'event',
    input: { companyId: 'c1', accountId: 'acc1', kind: 'contact.updated', payload: { id: 42 } },
  });
});

test('a payload that cannot be mapped is refused before any CRM call', async () => {
  const { sync, calls } = recorder();
  const dispatch = createProjectionDispatcher({ sync });

  const broken: unknown[] = [
    null,
    'message',
    [],
    { companyId: 'c1' },
    { ...messagePayload, op: 'teleport' },
    { ...messagePayload, conversationId: '' },
    { ...messagePayload, providerMessageId: undefined },
    { ...messagePayload, direction: 'sideways' },
    { ...messagePayload, occurredAt: 'not-a-date' },
    { op: 'event', companyId: 'c1', accountId: 'acc1', kind: '', payload: {} },
    { op: 'event', companyId: 'c1', accountId: 'acc1', kind: 'x', payload: 'not-an-object' },
  ];

  for (const payload of broken) {
    await assert.rejects(
      () => dispatch(payload),
      (error: unknown) => error instanceof AmocrmApiError && error.code === 'invalid_projection_payload',
      `payload ${JSON.stringify(payload)} must be refused`,
    );
  }
  assert.equal(calls.length, 0, 'no CRM call happens for a broken job');
});

test('what the producer writes is exactly what the dispatcher reads back', async () => {
  const { sync, calls } = recorder();
  const occurredAt = new Date('2026-10-26T10:00:00.000Z');

  const job = buildMessageJob({
    companyId: 'c1',
    accountId: 'acc1',
    conversationId: 'conv1',
    providerMessageId: 'msg-1',
    direction: 'in',
    text: 'Здравствуйте',
    phone: '+79991234567',
    email: null,
    occurredAt,
  });
  await createProjectionDispatcher({ sync })(job);

  assert.deepEqual(calls[0]!.input, {
    companyId: 'c1',
    accountId: 'acc1',
    conversationId: 'conv1',
    providerMessageId: 'msg-1',
    direction: 'in',
    text: 'Здравствуйте',
    phone: '+79991234567',
    email: null,
    occurredAt,
  });
});

test('a produced job is a jsonb object, never an array or a bare string', () => {
  const job = buildMessageJob({
    companyId: 'c1',
    accountId: 'acc1',
    conversationId: 'conv1',
    providerMessageId: 'msg-1',
    direction: 'in',
  });

  assert.equal(typeof job, 'object');
  assert.equal(Array.isArray(job), false);
  assert.equal(job.op, 'message');
  assert.equal(typeof job.occurredAt, 'string', 'a job without a timestamp still carries one');
});

test('an upstream failure is rethrown so the queue can retry the job', async () => {
  const sync: ProjectionSync = {
    async projectInboundMessage() {
      throw new AmocrmApiError(500, 'http_500');
    },
    async applyCrmEvent() {
      throw new AmocrmApiError(500, 'http_500');
    },
  };

  await assert.rejects(
    () => createProjectionDispatcher({ sync })(messagePayload),
    (error: unknown) => error instanceof AmocrmApiError && error.status === 500,
  );
});
