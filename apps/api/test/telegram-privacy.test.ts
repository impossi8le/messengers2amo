import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, TEST_DATABASE_URL } from './helpers/db.ts';
import { seedSendContext, telegramMessageUpdate } from './helpers/telegram.ts';
import { buildApp } from '../src/app.ts';
import { acceptSendCommand, runSendWorker } from '../src/telegram/send.ts';
import type { Config } from '../src/platform/config.ts';

const BOT_TOKEN = '987654:super-secret-bot-token';
const WEBHOOK_SECRET = 'webhook-secret-value';
const MESSAGE_TEXT = 'personal message body 89001234567';

const config: Config = {
  port: 0,
  host: '127.0.0.1',
  databaseUrl: TEST_DATABASE_URL,
  sessionSecret: 's'.repeat(40),
  sessionTtlSeconds: 3600,
  secureCookies: false,
  trustedProxy: false,
  adminBootstrapToken: null,
  s3: null,
  amocrm: null,
  telegram: { botToken: BOT_TOKEN, webhookSecret: WEBHOOK_SECRET, apiBase: 'https://tg.test' },
  metricsToken: null,
    outboundEnabled: true,
};

async function captureStdout(run: () => Promise<void>): Promise<string> {
  const original = process.stdout.write.bind(process.stdout);
  const lines: string[] = [];
  process.stdout.write = ((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await run();
  } finally {
    process.stdout.write = original;
  }
  return lines.join('');
}

test('ingress and egress logs never contain the bot token or message text', async () => {
  const { db, close } = await createTestDb();
  try {
    const ctx = await seedSendContext(db);
    const app = await buildApp({ config, db });
    try {
      const output = await captureStdout(async () => {
        const response = await app.inject({
          method: 'POST',
          url: `/webhooks/telegram/${ctx.connectionId}`,
          headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
          payload: telegramMessageUpdate(9001, 501, MESSAGE_TEXT) as object,
        });
        assert.equal(response.statusCode, 200);

        await acceptSendCommand(db, ctx, {
          commandType: 'reply',
          idempotencyKey: 'privacy-1',
          actorId: ctx.staffId,
          workItemId: ctx.workItemId,
          conversationId: ctx.conversationId,
          content: { text: MESSAGE_TEXT },
          deadlineSeconds: 60,
        });
        await runSendWorker(db, {
          companyId: ctx.companyId,
          connectionId: ctx.connectionId,
          owner: 'worker-privacy',
          leaseMs: 30_000,
          transport: {
            sendMessage: async () => {
              throw new Error(`network failed for ${BOT_TOKEN}`);
            },
          },
        });
      });

      assert.ok(output.length > 0, 'expected structured log output');
      assert.equal(output.includes(BOT_TOKEN), false, 'bot token leaked into logs');
      assert.equal(output.includes(MESSAGE_TEXT), false, 'message text leaked into logs');
      assert.equal(output.includes('89001234567'), false, 'phone-like PII leaked into logs');
    } finally {
      await app.close();
    }
  } finally {
    await close();
  }
});
