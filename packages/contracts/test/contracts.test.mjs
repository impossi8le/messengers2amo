import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const schemaUrl = new URL('../schema/v1.json', import.meta.url);
const schema = JSON.parse(readFileSync(schemaUrl, 'utf8'));

const ajv = new Ajv2020({
  strict: true,
  allErrors: true
});
addFormats(ajv);
ajv.addSchema(schema, 'https://internal.messenger.local/schemas/v1.json');

function getValidator(defName) {
  return ajv.compile({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $ref: `https://internal.messenger.local/schemas/v1.json#/$defs/${defName}`
  });
}

test('Contract Schema Suite - Compilation and Strict Rules', async (t) => {
  await t.test('All definitions compile cleanly under Ajv 2020 strict mode', () => {
    for (const defName of Object.keys(schema.$defs)) {
      const validate = getValidator(defName);
      assert.equal(typeof validate, 'function');
    }
  });

  await t.test('SendReplyRequest: Valid payload passes', () => {
    const validate = getValidator('SendReplyRequest');
    const validData = {
      idempotencyKey: 'cmd-reply-1001',
      snapshotId: 'snap-42',
      expectedAssignmentVersion: 3,
      selectedObligations: [
        { obligationId: 'ob-1', contentVersion: 0 },
        { obligationId: 'ob-2', contentVersion: 2 }
      ],
      text: 'Здравствуйте! Ваш заказ передан курьеру.',
      deadline: '2026-10-21T15:00:00.000Z'
    };
    assert.equal(validate(validData), true, JSON.stringify(validate.errors));
  });

  await t.test('SendReplyRequest: Actor or recipient injection rejected by strict additionalProperties', () => {
    const validate = getValidator('SendReplyRequest');
    const injectedPayload = {
      idempotencyKey: 'cmd-reply-1002',
      snapshotId: 'snap-42',
      expectedAssignmentVersion: 3,
      selectedObligations: [{ obligationId: 'ob-1', contentVersion: 0 }],
      text: 'Injected message',
      deadline: '2026-10-21T15:00:00.000Z',
      actorId: 'operator-spoofed-id',
      recipient: 'external-recipient'
    };
    assert.equal(validate(injectedPayload), false);
    assert.ok(validate.errors.some((err) => err.keyword === 'additionalProperties'));
  });

  await t.test('Capabilities: Unsupported capability state rejected', () => {
    const validate = getValidator('Capabilities');
    const invalidCapabilities = {
      textReply: 'supported',
      mediaReply: 'partially_working',
      readReceipts: 'unsupported',
      deliveryReceipts: 'unknown',
      messageEditing: 'unsupported',
      messageDeletion: 'unsupported'
    };
    assert.equal(validate(invalidCapabilities), false);
    assert.ok(validate.errors.some((err) => err.keyword === 'enum'));
  });

  await t.test('WorkItem: Negative or non-integer assignmentVersion rejected', () => {
    const validate = getValidator('WorkItem');
    const invalidWorkItemNegative = {
      id: 'work-1',
      conversationId: 'conv-1',
      assignmentVersion: -1,
      state: 'assigned',
      owner: 'op-12'
    };
    assert.equal(validate(invalidWorkItemNegative), false);
    assert.ok(validate.errors.some((err) => err.keyword === 'minimum'));

    const invalidWorkItemFloat = {
      id: 'work-1',
      conversationId: 'conv-1',
      assignmentVersion: 2.5,
      state: 'assigned',
      owner: 'op-12'
    };
    assert.equal(validate(invalidWorkItemFloat), false);
    assert.ok(validate.errors.some((err) => err.keyword === 'type'));
  });

  await t.test('ObligationRef: Negative or malformed contentVersion rejected', () => {
    const validate = getValidator('ObligationRef');
    assert.equal(validate({ obligationId: 'ob-1', contentVersion: -5 }), false);
    assert.equal(validate({ obligationId: '', contentVersion: 0 }), false);
  });

  await t.test('EventEnvelope: Valid message.received and strict discriminator', () => {
    const validate = getValidator('EventEnvelope');
    const validEvent = {
      schemaVersion: 1,
      eventId: 'evt-101',
      connectionId: 'conn-1',
      bindingEpoch: 0,
      providerEventKey: 'tg-upd-9988',
      occurredAt: '2026-10-21T12:00:00.000Z',
      receivedAt: '2026-10-21T12:00:01.000Z',
      kind: 'message.received',
      payload: {
        conversationId: 'conv-1', externalChatId: 'chat-1', providerMessageId: 'provider-msg-1', sourceMode: 'live', importJobId: null,
        messageId: 'msg-501', content: {kind: 'text', text: 'Помогите с заказом'},
        obligationId: 'ob-501',
        contentVersion: 0
      }
    };
    assert.equal(validate(validEvent), true, JSON.stringify(validate.errors));
  });

  await t.test('EventEnvelope: Mismatched payload for kind rejected', () => {
    const validate = getValidator('EventEnvelope');
    const mismatchedEvent = {
      schemaVersion: 1,
      eventId: 'evt-102',
      connectionId: 'conn-1',
      bindingEpoch: 0,
      providerEventKey: 'tg-upd-9989',
      occurredAt: '2026-10-21T12:00:00.000Z',
      receivedAt: '2026-10-21T12:00:01.000Z',
      kind: 'message.received',
      payload: {
        sendOperationId: 'send-1',
        status: 'sent',
        providerMessageId: 'p-1'
      }
    };
    assert.equal(validate(mismatchedEvent), false);
  });
});
