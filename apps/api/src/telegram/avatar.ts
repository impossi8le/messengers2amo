import { downloadTelegramMedia, TelegramMediaError } from './media.ts';

export class TelegramAvatarError extends Error {
  readonly code: 'telegram_avatar_invalid' | 'telegram_avatar_unavailable';
  constructor(code: 'telegram_avatar_invalid' | 'telegram_avatar_unavailable') {
    super(code);
    this.name = 'TelegramAvatarError';
    this.code = code;
  }
}

const MAX_AVATAR_BYTES = 1024 * 1024;
const MAX_METADATA_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 15000;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

async function readBounded(
  response: Response,
  limit: number,
  deadline: Promise<never>,
): Promise<Uint8Array> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
    void response.body?.cancel().catch(() => {});
    throw new TelegramAvatarError('telegram_avatar_unavailable');
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await Promise.race([reader.read(), deadline]);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) throw new TelegramAvatarError('telegram_avatar_unavailable');
      chunks.push(part.value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  return new Uint8Array(Buffer.concat(chunks, size));
}

function mapMediaError(error: TelegramMediaError): TelegramAvatarError {
  if (error.code === 'telegram_media_too_large') return new TelegramAvatarError('telegram_avatar_invalid');
  if (error.code === 'telegram_media_invalid') return new TelegramAvatarError('telegram_avatar_invalid');
  return new TelegramAvatarError('telegram_avatar_unavailable');
}

/** Downloads the current public Telegram profile photo as a bounded JPEG byte array.
 * Returns null when the user has no public profile photos. Provider credentials and
 * download URLs never leave this function; errors contain only stable codes.
 */
export async function downloadTelegramAvatar(input: {
  botToken: string;
  userId: number;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}): Promise<Uint8Array | null> {
  if (!input.botToken || /[\s/\\?#]/.test(input.botToken)) {
    throw new TelegramAvatarError('telegram_avatar_invalid');
  }
  if (!Number.isSafeInteger(input.userId) || input.userId <= 0) {
    throw new TelegramAvatarError('telegram_avatar_invalid');
  }
  const maxBytes = Math.min(input.maxBytes ?? MAX_AVATAR_BYTES, MAX_AVATAR_BYTES);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TelegramAvatarError('telegram_avatar_invalid');
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TelegramAvatarError('telegram_avatar_invalid');

  const deadlineAt = Date.now() + timeoutMs;
  const remainingMs = (): number => Math.max(1, deadlineAt - Date.now());
  const fetchImpl = input.fetch ?? globalThis.fetch;

  const controller = new AbortController();
  let rejectDeadline!: (error: TelegramAvatarError) => void;
  const deadline = new Promise<never>((_, reject) => {
    rejectDeadline = reject;
  });
  const timer = setTimeout(() => {
    controller.abort();
    rejectDeadline(new TelegramAvatarError('telegram_avatar_unavailable'));
  }, remainingMs());

  try {
    const metadata = await Promise.race([
      fetchImpl(`https://api.telegram.org/bot${input.botToken}/getUserProfilePhotos`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ user_id: input.userId, limit: 1 }),
        redirect: 'error',
        signal: controller.signal,
      }),
      deadline,
    ]);
    if (!metadata.ok) {
      void metadata.body?.cancel().catch(() => {});
      throw new TelegramAvatarError('telegram_avatar_unavailable');
    }
    const payload = record(JSON.parse(Buffer.from(await readBounded(metadata, MAX_METADATA_BYTES, deadline)).toString('utf8')));
    if (payload?.ok !== true) throw new TelegramAvatarError('telegram_avatar_unavailable');
    const result = record(payload.result);
    const totalCount = Number(result?.total_count ?? 0);
    if (!Number.isSafeInteger(totalCount) || totalCount < 0) throw new TelegramAvatarError('telegram_avatar_unavailable');
    if (totalCount === 0) return null;
    const photoSets = Array.isArray(result?.photos) ? result.photos : null;
    if (!photoSets || photoSets.length === 0) return null;
    const sizes = Array.isArray(photoSets[0]) ? photoSets[0] : [photoSets[0]];
    const candidates = sizes
      .map(record)
      .filter((item): item is Record<string, unknown> =>
        item !== null &&
        typeof item.file_id === 'string' &&
        item.file_id.length > 0 &&
        item.file_id.length <= 1024,
      );
    if (candidates.length === 0) throw new TelegramAvatarError('telegram_avatar_invalid');
    candidates.sort(
      (a, b) =>
        Number(b.file_size ?? Number(b.width ?? 0) * Number(b.height ?? 0)) -
        Number(a.file_size ?? Number(a.width ?? 0) * Number(a.height ?? 0)),
    );
    const selected = candidates[0]!;
    const fileId = selected.file_id as string;
    const bytes = await Promise.race([downloadTelegramMedia({
      botToken: input.botToken,
      fileId,
      fetch: input.fetch,
      timeoutMs: remainingMs(),
      maxBytes,
    }),deadline]);
    if (!isJpeg(bytes)) throw new TelegramAvatarError('telegram_avatar_invalid');
    return bytes;
  } catch (error) {
    if (error instanceof TelegramAvatarError) throw error;
    if (error instanceof TelegramMediaError) throw mapMediaError(error);
    throw new TelegramAvatarError('telegram_avatar_unavailable');
  } finally {
    clearTimeout(timer);
  }
}
