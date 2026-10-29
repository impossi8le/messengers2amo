import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTokenCipher } from '../src/integrations/amocrm/crypto.ts';
import {
  verifyTelegramBotToken,
  encryptTelegramCredentials,
  decryptTelegramCredentials,
} from '../src/connections/telegram-setup.ts';

const TEST_KEY = '0123456789abcdef0123456789abcdef';

type RecordedCall = {
  url: string;
  init?: RequestInit;
};

function jsonResponse(data: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

test('valid bot: returns providerId and displayName with first_name and username fallback', async () => {
  const fakeFetchWithFirst: typeof fetch = async () =>
    jsonResponse({
      ok: true,
      result: {
        id: 12345678,
        is_bot: true,
        username: 'my_awesome_bot',
        first_name: 'Awesome Bot',
      },
    });

  const res1 = await verifyTelegramBotToken({
    botToken: '12345678:ABC-DEF1234ghIkl-zyx57W2v1u123ew11',
    fetch: fakeFetchWithFirst,
  });
  assert.deepEqual(res1, {
    providerId: '12345678',
    displayName: 'Awesome Bot',
  });

  const fakeFetchWithoutFirst: typeof fetch = async () =>
    jsonResponse({
      ok: true,
      result: {
        id: 998877,
        is_bot: true,
        username: 'fallback_bot',
      },
    });

  const res2 = await verifyTelegramBotToken({
    botToken: '998877:XYZ-token',
    fetch: fakeFetchWithoutFirst,
  });
  assert.deepEqual(res2, {
    providerId: '998877',
    displayName: 'fallback_bot',
  });
});

test('bad auth: 401 response or error_code 401 rejects with unauthorized error', async () => {
  const fakeFetch401: typeof fetch = async () =>
    jsonResponse({ ok: false, error_code: 401, description: 'Unauthorized' }, { status: 401 });

  await assert.rejects(
    async () => {
      await verifyTelegramBotToken({
        botToken: '123456:invalid-token',
        fetch: fakeFetch401,
      });
    },
    { message: 'unauthorized' },
  );

  const fakeFetch200Error: typeof fetch = async () =>
    jsonResponse({ ok: false, error_code: 401, description: 'Unauthorized' }, { status: 200 });

  await assert.rejects(
    async () => {
      await verifyTelegramBotToken({
        botToken: '123456:invalid-token',
        fetch: fakeFetch200Error,
      });
    },
    { message: 'unauthorized' },
  );
});

test('invalid bot ID / user not bot: rejects malformed result structures', async () => {
  const invalidCases: Array<{ result: Record<string, unknown>; expectedErr: RegExp }> = [
    {
      result: { id: 0, is_bot: true, username: 'bot' },
      expectedErr: /invalid_bot_id/,
    },
    {
      result: { id: -42, is_bot: true, username: 'bot' },
      expectedErr: /invalid_bot_id/,
    },
    {
      result: { id: 123.456, is_bot: true, username: 'bot' },
      expectedErr: /invalid_bot_id/,
    },
    {
      result: { id: '12345', is_bot: true, username: 'bot' },
      expectedErr: /invalid_bot_id/,
    },
    {
      result: { id: 12345, is_bot: false, username: 'human_user' },
      expectedErr: /user_is_not_bot/,
    },
    {
      result: { id: 12345, is_bot: true, username: '' },
      expectedErr: /invalid_bot_username/,
    },
    {
      result: { id: 12345, is_bot: true },
      expectedErr: /invalid_bot_username/,
    },
  ];

  for (const { result, expectedErr } of invalidCases) {
    const fakeFetch: typeof fetch = async () => jsonResponse({ ok: true, result });
    await assert.rejects(async () => {
      await verifyTelegramBotToken({
        botToken: '12345:token',
        fetch: fakeFetch,
      });
    }, expectedErr);
  }
});

test('no raw-token errors: never leaks token in thrown errors', async () => {
  const SENSITIVE_TOKEN = 'SUPER_SECRET_TOKEN_RAW_VALUE_999999999';

  // Network failure where underlying error contains token
  const networkFailingFetch: typeof fetch = async () => {
    throw new Error(
      `Connection reset by peer while requesting https://api.telegram.org/bot${SENSITIVE_TOKEN}/getMe`,
    );
  };

  try {
    await verifyTelegramBotToken({
      botToken: SENSITIVE_TOKEN,
      fetch: networkFailingFetch,
    });
    assert.fail('should have thrown');
  } catch (err) {
    const message = (err as Error).message;
    const fullString = String(err);
    assert.ok(!message.includes(SENSITIVE_TOKEN), 'message must not contain raw token');
    assert.ok(!fullString.includes(SENSITIVE_TOKEN), 'stringified error must not contain raw token');
    assert.equal(message, 'network_error');
  }

  // 401 unauthorized error
  const authFailingFetch: typeof fetch = async () =>
    jsonResponse({ ok: false, error_code: 401, description: 'Unauthorized' }, { status: 401 });

  try {
    await verifyTelegramBotToken({
      botToken: SENSITIVE_TOKEN,
      fetch: authFailingFetch,
    });
    assert.fail('should have thrown');
  } catch (err) {
    const message = (err as Error).message;
    assert.ok(!message.includes(SENSITIVE_TOKEN));
    assert.equal(message, 'unauthorized');
  }

  // Invalid token length error
  const emptyToken = '';
  try {
    await verifyTelegramBotToken({
      botToken: emptyToken,
      fetch: async () => jsonResponse({ ok: true }),
    });
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal((err as Error).message, 'invalid_token');
  }
});

test('redirect:error: enforces redirect error mode and GET method', async () => {
  const recordedCalls: RecordedCall[] = [];

  const fakeFetch: typeof fetch = async (url, init) => {
    recordedCalls.push({ url: String(url), init });
    return jsonResponse({
      ok: true,
      result: { id: 777, is_bot: true, username: 'redirect_test_bot' },
    });
  };

  await verifyTelegramBotToken({
    botToken: '777:token',
    fetch: fakeFetch,
    apiBase: 'https://custom.tg.test/',
  });

  assert.equal(recordedCalls.length, 1);
  const call = recordedCalls[0];
  assert.ok(call);
  assert.equal(call.url, 'https://custom.tg.test/bot777:token/getMe');
  assert.equal(call.init?.method, 'GET');
  assert.equal(call.init?.redirect, 'error');
  assert.ok(call.init?.signal instanceof AbortSignal);
});

test('size limit: rejects response bodies exceeding 64KB', async () => {
  const MAX_LIMIT = 64 * 1024; // 65536 bytes

  // Header content-length over limit
  const largeHeadersFetch: typeof fetch = async () =>
    new Response('x'.repeat(100), {
      status: 200,
      headers: {
        'content-length': String(MAX_LIMIT + 1),
        'content-type': 'application/json',
      },
    });

  await assert.rejects(
    async () => {
      await verifyTelegramBotToken({
        botToken: '123:token',
        fetch: largeHeadersFetch,
      });
    },
    { message: 'response_too_large' },
  );

  // Streamed body over limit
  const largeBody = 'a'.repeat(MAX_LIMIT + 100);
  const largeBodyFetch: typeof fetch = async () =>
    new Response(largeBody, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  await assert.rejects(
    async () => {
      await verifyTelegramBotToken({
        botToken: '123:token',
        fetch: largeBodyFetch,
      });
    },
    { message: 'response_too_large' },
  );
});

test('encryption scope tamper: rejects scope mismatch and invalid versions', () => {
  const cipher = createTokenCipher(TEST_KEY);
  const credentials = {
    companyId: 'company_alpha',
    connectionId: 'conn_100',
    botToken: '987654:ABC-bot-secret',
    webhookSecret: 'secret_webhook_key_xyz',
  };

  const encryptedBlob = encryptTelegramCredentials(cipher, credentials);
  assert.ok(encryptedBlob.startsWith('chancred_v1.'));

  // Decrypt with correct scope succeeds
  const decrypted = decryptTelegramCredentials(cipher, encryptedBlob, {
    companyId: 'company_alpha',
    connectionId: 'conn_100',
  });
  assert.deepEqual(decrypted, {
    botToken: '987654:ABC-bot-secret',
    webhookSecret: 'secret_webhook_key_xyz',
  });

  // Tampered companyId rejects
  assert.throws(
    () => {
      decryptTelegramCredentials(cipher, encryptedBlob, {
        companyId: 'company_beta',
        connectionId: 'conn_100',
      });
    },
    { message: 'scope_mismatch' },
  );

  // Tampered connectionId rejects
  assert.throws(
    () => {
      decryptTelegramCredentials(cipher, encryptedBlob, {
        companyId: 'company_alpha',
        connectionId: 'conn_200',
      });
    },
    { message: 'scope_mismatch' },
  );

  // Unknown envelope version rejects
  const wrongVersionBlob = encryptedBlob.replace('chancred_v1.', 'chancred_v2.');
  assert.throws(
    () => {
      decryptTelegramCredentials(cipher, wrongVersionBlob, {
        companyId: 'company_alpha',
        connectionId: 'conn_100',
      });
    },
    { message: 'unsupported_envelope_version' },
  );

  // Corrupted ciphertext rejects
  const corruptedBlob = `chancred_v1.${encryptedBlob.slice('chancred_v1.'.length).slice(0, -4)}AAAA`;
  assert.throws(
    () => {
      decryptTelegramCredentials(cipher, corruptedBlob, {
        companyId: 'company_alpha',
        connectionId: 'conn_100',
      });
    },
    { message: 'decryption_failed' },
  );
});

test('encrypted no plaintext: envelope never contains raw token or secret', () => {
  const cipher = createTokenCipher(TEST_KEY);
  const secretBotToken = 'HIGHLY_SENSITIVE_BOT_TOKEN_123456';
  const secretWebhook = 'SUPER_SECRET_WEBHOOK_STRING_789012';

  const blob = encryptTelegramCredentials(cipher, {
    companyId: 'cmp_1',
    connectionId: 'cn_1',
    botToken: secretBotToken,
    webhookSecret: secretWebhook,
  });

  assert.ok(!blob.includes(secretBotToken), 'blob must not contain plaintext bot token');
  assert.ok(!blob.includes(secretWebhook), 'blob must not contain plaintext webhook secret');

  const restored = decryptTelegramCredentials(cipher, blob, {
    companyId: 'cmp_1',
    connectionId: 'cn_1',
  });

  assert.equal(restored.botToken, secretBotToken);
  assert.equal(restored.webhookSecret, secretWebhook);
});
