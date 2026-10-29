import { sanitizeFileName } from '../media/policy.ts';

export type TelegramMediaReference = {
  fileId: string; fileName: string; mimeType: string; sizeBytes: number | null;
  type: 'picture' | 'file' | 'video' | 'voice' | 'audio';
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function telegramMediaOf(message: Record<string, unknown>): TelegramMediaReference | null {
  const kinds = [
    ['photo','picture','photo.jpg','image/jpeg'], ['document','file','attachment','application/octet-stream'],
    ['video','video','video.mp4','video/mp4'], ['voice','voice','voice.ogg','audio/ogg'],
    ['audio','audio','audio.mp3','audio/mpeg'],
  ] as const;
  for (const [field,type,fileName,mimeType] of kinds) {
    const raw = message[field];
    const candidates = field === 'photo' && Array.isArray(raw) ? raw : [raw];
    const valid = candidates.map(record).filter((item): item is Record<string, unknown> => Boolean(item &&
      typeof item.file_id === 'string' && item.file_id.length > 0 && item.file_id.length <= 1024 &&
      (item.file_size === undefined || (Number.isSafeInteger(item.file_size) && Number(item.file_size) >= 0))));
    // Telegram orders PhotoSize by size, but tolerate an unordered payload.
    valid.sort((a,b) => Number(b.file_size ?? Number(b.width ?? 0)*Number(b.height ?? 0)) - Number(a.file_size ?? Number(a.width ?? 0)*Number(a.height ?? 0)));
    const item = valid[0];
    if (item) return {
      fileId:item.file_id as string,type,
      fileName:sanitizeFileName(typeof item.file_name === 'string' ? item.file_name : fileName),
      mimeType:typeof item.mime_type === 'string' ? item.mime_type : mimeType,
      sizeBytes:typeof item.file_size === 'number' ? item.file_size : null,
    };
  }
  return null;
}

export class TelegramMediaError extends Error {
  readonly code: string;
  constructor(code: 'telegram_media_invalid' | 'telegram_media_too_large' | 'telegram_media_unavailable') {
    super(code); this.name = 'TelegramMediaError'; this.code = code;
  }
}

const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

/** Fixed provider origin; credentials and provider download URLs never leave this function. */
export async function downloadTelegramMedia(input: {
  botToken: string; fileId: string; fetch?: typeof fetch; timeoutMs?: number; maxBytes?: number;
}): Promise<Uint8Array> {
  if (!input.botToken || /[\s/\\?#]/.test(input.botToken) || !input.fileId || input.fileId.length > 1024) {
    throw new TelegramMediaError('telegram_media_invalid');
  }
  const maxBytes = Math.min(input.maxBytes ?? MAX_DOWNLOAD_BYTES, MAX_DOWNLOAD_BYTES);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TelegramMediaError('telegram_media_invalid');
  const controller = new AbortController();
  let rejectDeadline!: (error: TelegramMediaError) => void;
  const deadline = new Promise<never>((_,reject) => { rejectDeadline = reject; });
  const timer = setTimeout(() => {
    controller.abort(); rejectDeadline(new TelegramMediaError('telegram_media_unavailable'));
  }, input.timeoutMs ?? 15000);
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const request = (url: string, init: RequestInit) => Promise.race([
    fetchImpl(url,{...init,redirect:'error',signal:controller.signal}),deadline,
  ]);
  const read = async (response: Response, limit: number): Promise<Uint8Array> => {
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
      void response.body?.cancel().catch(() => {});
      throw new TelegramMediaError('telegram_media_too_large');
    }
    const reader = response.body?.getReader();
    if (!reader) return new Uint8Array();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await Promise.race([reader.read(),deadline]);
        if (part.done) break;
        size += part.value.byteLength;
        if (size > limit) throw new TelegramMediaError('telegram_media_too_large');
        chunks.push(part.value);
      }
    } catch (error) {
      void reader.cancel().catch(() => {});
      throw error;
    } finally { reader.releaseLock(); }
    return new Uint8Array(Buffer.concat(chunks,size));
  };
  try {
    const metadata = await request(`https://api.telegram.org/bot${input.botToken}/getFile`,{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({file_id:input.fileId}),
    });
    if (!metadata.ok) { void metadata.body?.cancel().catch(() => {}); throw new TelegramMediaError('telegram_media_unavailable'); }
    const payload = record(JSON.parse(Buffer.from(await read(metadata,64*1024)).toString('utf8')));
    const file = record(payload?.result);
    const path = file?.file_path;
    if (payload?.ok !== true || file?.file_id !== input.fileId || typeof path !== 'string' ||
        path.length > 2048 || !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(path) ||
        path.split('/').some((part) => part === '.' || part === '..')) throw new TelegramMediaError('telegram_media_invalid');
    if (file.file_size !== undefined && (!Number.isSafeInteger(file.file_size) || Number(file.file_size) < 0)) {
      throw new TelegramMediaError('telegram_media_invalid');
    }
    if (Number(file.file_size ?? 0) > maxBytes) throw new TelegramMediaError('telegram_media_too_large');
    const response = await request(`https://api.telegram.org/file/bot${input.botToken}/${path}`,{method:'GET'});
    if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new TelegramMediaError('telegram_media_unavailable'); }
    const bytes = await read(response,maxBytes);
    if (file.file_size !== undefined && file.file_size !== bytes.byteLength) throw new TelegramMediaError('telegram_media_invalid');
    return bytes;
  } catch (error) {
    if (error instanceof TelegramMediaError) throw error;
    throw new TelegramMediaError('telegram_media_unavailable');
  } finally { clearTimeout(timer); }
}
