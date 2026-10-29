export type MediaLimits = {
  maxFileBytes: number;
  maxMessageBytes: number;
  allowedMimeTypes: readonly string[];
  /** Simultaneous upload bodies the API will hold in memory. */
  maxConcurrentUploads: number;
};

export const DEFAULT_MAX_FILE_BYTES = 100 * 1024 * 1024;
export const DEFAULT_MAX_MESSAGE_BYTES = 100 * 1024 * 1024;
/** Worst-case buffered body memory is this times maxFileBytes. The API container is
 * capped at 512 MiB, so 8 × 100 MiB could never fit and the kernel would kill the
 * process mid-upload; two leaves room for the heap. Overflow answers 429 + retry-after. */
export const DEFAULT_MAX_CONCURRENT_UPLOADS = 2;

/** Conservative allowlist: no executables, no scripts, no archives of unknown content. */
export const DEFAULT_ALLOWED_MIME_TYPES: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'application/pdf',
  'text/plain',
  'text/csv',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'video/mp4',
  'video/webm',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];

export const PLACEHOLDER_MIME_TYPE = 'application/octet-stream';
export const PLACEHOLDER_NAME_PREFIX = '[attachment unavailable]';

export function defaultLimits(overrides: Partial<MediaLimits> = {}): MediaLimits {
  return {
    maxFileBytes: overrides.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    maxMessageBytes: overrides.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES,
    allowedMimeTypes: overrides.allowedMimeTypes ?? DEFAULT_ALLOWED_MIME_TYPES,
    maxConcurrentUploads: overrides.maxConcurrentUploads ?? DEFAULT_MAX_CONCURRENT_UPLOADS,
  };
}

/** Strips parameters (`; charset=...`) and lowercases; returns null when malformed. */
export function normalizeMimeType(raw: string): string | null {
  const value = raw.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(value)) return null;
  return value;
}

export function isAllowedMimeType(mime: string | null, allowed: readonly string[]): boolean {
  if (!mime) return false;
  return allowed.includes(mime);
}

/**
 * Keeps the original name recognisable while removing path separators and
 * control characters. Never empty.
 */
export function sanitizeFileName(raw: string): string {
  const cleaned = raw
    .replace(/[\\/]+/g, '_')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 200);
  return cleaned.length > 0 ? cleaned : 'attachment';
}

export function displayNameFromStorageKey(key: string): string {
  const last = key.split('/').pop() ?? '';
  try {
    return decodeURIComponent(last) || 'attachment';
  } catch {
    return last || 'attachment';
  }
}
