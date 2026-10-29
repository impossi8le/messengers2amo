import { test } from 'node:test';
import assert from 'node:assert/strict';
import { downloadTelegramAvatar, TelegramAvatarError } from '../src/telegram/avatar.ts';

const token = '123:synthetic-token';
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

function json(value: unknown) {
  return new Response(JSON.stringify(value));
}

function profileMetadata(totalCount: number, fileId = 'photo-file-id') {
  return json({
    ok: true,
    result: {
      total_count: totalCount,
      photos: totalCount > 0 ? [[{ file_id: fileId, file_size: jpeg.length, width: 100, height: 100 }]] : [],
    },
  });
}

function fileMetadata(fileSize = jpeg.length) {
  return json({ ok: true, result: { file_id: 'photo-file-id', file_path: 'photos/file.jpg', file_size: fileSize } });
}

test('rejects invalid inputs without provider contact', async () => {
  const badTokenCases = ['', 'has space', 'has/slash', 'has\\backslash', 'has?question', 'has#hash'];
  for (const botToken of badTokenCases) {
    await assert.rejects(
      () => downloadTelegramAvatar({ botToken, userId: 1 }),
      (error: unknown) => error instanceof TelegramAvatarError && error.code === 'telegram_avatar_invalid',
    );
  }
  for (const userId of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      () => downloadTelegramAvatar({ botToken: token, userId }),
      (error: unknown) => error instanceof TelegramAvatarError && error.code === 'telegram_avatar_invalid',
    );
  }
  await assert.rejects(
    () => downloadTelegramAvatar({ botToken: token, userId: 1, maxBytes: 0 }),
    /telegram_avatar_invalid/,
  );
  await assert.rejects(
    () => downloadTelegramAvatar({ botToken: token, userId: 1, timeoutMs: 0 }),
    /telegram_avatar_invalid/,
  );
});

test('returns null for empty public profile', async () => {
  const bytes = await downloadTelegramAvatar({
    botToken: token,
    userId: 42,
    fetch: async () => profileMetadata(0),
  });
  assert.equal(bytes, null);
});

test('downloads the largest photo from Telegram with bounded bodies and no redirects', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const bytes = await downloadTelegramAvatar({
    botToken: token,
    userId: 42,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) return profileMetadata(1);
      if (calls.length === 2) return fileMetadata();
      return new Response(jpeg);
    },
  });
  assert.deepEqual(bytes, jpeg);
  assert.equal(calls[0]!.url, `https://api.telegram.org/bot${token}/getUserProfilePhotos`);
  assert.equal(calls[0]!.init?.body, JSON.stringify({ user_id: 42, limit: 1 }));
  assert.equal(calls[0]!.init?.method, 'POST');
  assert.equal(calls[1]!.url, `https://api.telegram.org/bot${token}/getFile`);
  assert.equal(calls[2]!.url, `https://api.telegram.org/file/bot${token}/photos/file.jpg`);
  assert.ok(calls.every((call) => call.init?.redirect === 'error'));
});

test('selects the largest photo size from the first photo set', async () => {
  const calls: { url: string; body?: string }[] = [];
  await downloadTelegramAvatar({
    botToken: token,
    userId: 42,
    fetch: async (url, init) => {
      calls.push({ url: String(url), body: init?.body as string | undefined });
      if (calls.length === 1) {
        return json({
          ok: true,
          result: {
            total_count: 1,
            photos: [[
              { file_id: 'small', file_size: 100, width: 10, height: 10 },
              { file_id: 'large', file_size: 500, width: 50, height: 50 },
              { file_id: 'medium', file_size: 300, width: 30, height: 30 },
            ]],
          },
        });
      }
      if (calls.length === 2) return json({ ok: true, result: { file_id: 'large', file_path: 'photos/large.jpg', file_size: jpeg.length } });
      return new Response(jpeg);
    },
  });
  assert.ok(calls[1]!.body?.includes('large'));
});

test('rejects non-JPEG content and provider failures without exposing credentials', async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const calls: number[] = [];
  await assert.rejects(
    () =>
      downloadTelegramAvatar({
        botToken: token,
        userId: 42,
        fetch: async () => {
          calls.push(calls.length);
          if (calls.length === 1) return profileMetadata(1);
          if (calls.length === 2) return fileMetadata();
          return new Response(png);
        },
      }),
    (error: unknown) =>
      error instanceof TelegramAvatarError &&
      error.code === 'telegram_avatar_invalid' &&
      !String(error).includes(token) &&
      !String(error.stack).includes(token),
  );
});

test('enforces declared and actual download size limits', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      downloadTelegramAvatar({
        botToken: token,
        userId: 42,
        maxBytes: 4,
        fetch: async () => {
          calls++;
          return profileMetadata(1, 'big');
        },
      }),
    /telegram_avatar_invalid/,
  );
  assert.equal(calls, 2); // metadata + getFile metadata, then downloadTelegramMedia sees declared size > maxBytes
  calls = 0;
  const bigJpeg = new Uint8Array([0xff, 0xd8, 0xff, ...Array(200).fill(0)]);
  let cancelled = false;
  await assert.rejects(
    () =>
      downloadTelegramAvatar({
        botToken: token,
        userId: 42,
        maxBytes: 50,
        fetch: async () => {
          calls++;
          if (calls === 1) return profileMetadata(1);
          if (calls === 2) return fileMetadata(10);
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(bigJpeg);
              },
              cancel() {
                cancelled = true;
              },
            }),
          );
        },
      }),
    /telegram_avatar_invalid/,
  );
  assert.equal(cancelled, true);
});

test('rejects oversized metadata responses and malformed payloads', async () => {
  const oversizedBody = JSON.stringify({ ok: true, result: { total_count: 1, photos: [[{ file_id: 'x' }]] } }) + 'x'.repeat(64 * 1024);
  await assert.rejects(
    () => downloadTelegramAvatar({ botToken: token, userId: 42, fetch: async () => new Response(oversizedBody) }),
    /telegram_avatar_unavailable/,
  );
  await assert.rejects(
    () => downloadTelegramAvatar({ botToken: token, userId: 42, fetch: async () => json({ ok: false }) }),
    /telegram_avatar_unavailable/,
  );
});

test('deadline covers a stalled response even when an injected fetch ignores the signal', async () => {
  const start = Date.now();
  await assert.rejects(
    () =>
      downloadTelegramAvatar({
        botToken: token,
        userId: 42,
        timeoutMs: 30,
        fetch: async () => new Response(new ReadableStream({ start() {} })),
      }),
    /telegram_avatar_unavailable/,
  );
  assert.ok(Date.now() - start < 1000);
});

test('total deadline applies across both metadata and media download', async () => {
  const start = Date.now();
  let stage = 0;
  await assert.rejects(
    () =>
      downloadTelegramAvatar({
        botToken: token,
        userId: 42,
        timeoutMs: 60,
        fetch: async () => {
          stage++;
          if (stage === 1) return profileMetadata(1);
          return new Response(new ReadableStream({ start() {} }));
        },
      }),
    /telegram_avatar_unavailable/,
  );
  assert.ok(Date.now() - start < 1000);
  assert.equal(stage, 2);
});
