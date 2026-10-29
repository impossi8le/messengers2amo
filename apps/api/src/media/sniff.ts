/**
 * Content-based type checks for uploaded bytes.
 *
 * A declared `content-type` is a claim, not evidence. Every binary type on the
 * allowlist has a stable signature, so the bytes are sniffed and compared with the
 * declared type and with the file-name extension. Content that is positively
 * identified as something else is refused; content with no signature at all is
 * left to the declared type (text formats have no magic number).
 */

export type SniffResult = { type: string; kind: 'binary' | 'text' } | null;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff]);
const GIF87 = Buffer.from('GIF87a', 'ascii');
const GIF89 = Buffer.from('GIF89a', 'ascii');
const PDF = Buffer.from('%PDF-', 'ascii');
const OGG = Buffer.from('OggS', 'ascii');
const WAV_RIFF = Buffer.from('RIFF', 'ascii');
const WAV_WAVE = Buffer.from('WAVE', 'ascii');
const WEBP = Buffer.from('WEBP', 'ascii');
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const PE = Buffer.from('MZ', 'ascii');
const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
const MATROSKA = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
const ID3 = Buffer.from('ID3', 'ascii');

/** OOXML packages are ZIP containers; only their extension says which one. */
const OOXML_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

function startsWith(bytes: Uint8Array, prefix: Buffer): boolean {
  if (bytes.byteLength < prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (bytes[index] !== prefix[index]) return false;
  }
  return true;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return Buffer.from(bytes.subarray(start, Math.min(end, bytes.byteLength))).toString('latin1');
}

function looksLikeText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 4096);
  if (sample.byteLength === 0) return false;
  for (const byte of sample) {
    // NUL and most C0 control characters mean binary.
    if (byte === 0x00) return false;
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) return false;
  }
  return true;
}

/** Identifies the content by signature. Returns null when nothing matches. */
export function sniffContent(bytes: Uint8Array): SniffResult {
  if (startsWith(bytes, PNG)) return { type: 'image/png', kind: 'binary' };
  if (startsWith(bytes, JPEG)) return { type: 'image/jpeg', kind: 'binary' };
  if (startsWith(bytes, GIF87) || startsWith(bytes, GIF89)) return { type: 'image/gif', kind: 'binary' };
  if (startsWith(bytes, PDF)) return { type: 'application/pdf', kind: 'binary' };
  if (startsWith(bytes, OGG)) return { type: 'audio/ogg', kind: 'binary' };
  if (startsWith(bytes, MATROSKA)) return { type: 'video/webm', kind: 'binary' };
  if (startsWith(bytes, ZIP)) return { type: 'application/zip', kind: 'binary' };
  if (startsWith(bytes, PE)) return { type: 'application/x-msdownload', kind: 'binary' };
  if (startsWith(bytes, ELF)) return { type: 'application/x-executable', kind: 'binary' };
  if (startsWith(bytes, ID3)) return { type: 'audio/mpeg', kind: 'binary' };
  if (startsWith(bytes, WAV_RIFF) && ascii(bytes, 8, 12) === WAV_WAVE.toString('ascii')) {
    return { type: 'audio/wav', kind: 'binary' };
  }
  if (startsWith(bytes, WAV_RIFF) && ascii(bytes, 8, 12) === WEBP.toString('ascii')) {
    return { type: 'image/webp', kind: 'binary' };
  }
  // ISO base media (MP4/HEIC): a box length followed by `ftyp` and a brand.
  if (bytes.byteLength >= 12 && ascii(bytes, 4, 8) === 'ftyp') {
    const brand = ascii(bytes, 8, 12);
    if (['heic', 'heix', 'hevc', 'mif1', 'msf1'].includes(brand)) return { type: 'image/heic', kind: 'binary' };
    return { type: 'video/mp4', kind: 'binary' };
  }
  // MP3 frames without an ID3 tag.
  if (bytes.byteLength >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) {
    return { type: 'audio/mpeg', kind: 'binary' };
  }
  if (looksLikeText(bytes)) return { type: 'text/plain', kind: 'text' };
  return null;
}

const EXTENSION_TYPES: Record<string, readonly string[]> = {
  png: ['image/png'],
  jpg: ['image/jpeg'],
  jpeg: ['image/jpeg'],
  gif: ['image/gif'],
  webp: ['image/webp'],
  heic: ['image/heic'],
  pdf: ['application/pdf'],
  txt: ['text/plain'],
  csv: ['text/csv', 'text/plain'],
  mp3: ['audio/mpeg'],
  ogg: ['audio/ogg'],
  wav: ['audio/wav'],
  mp4: ['video/mp4'],
  webm: ['video/webm'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
};

function extensionOf(fileName: string): string | null {
  const match = /\.([A-Za-z0-9]{1,10})$/.exec(fileName);
  return match ? match[1]!.toLowerCase() : null;
}

/** True when the file name's extension is a known, compatible one for `mimeType`. */
export function extensionMatches(fileName: string, mimeType: string): boolean {
  const extension = extensionOf(fileName);
  if (!extension) return true; // no claim to contradict
  const allowed = EXTENSION_TYPES[extension];
  if (!allowed) return false; // an extension we never serve: .exe, .js, .html, ...
  return allowed.includes(mimeType);
}

/**
 * Decides whether the bytes may be published as `declaredType` under `fileName`.
 * Returns a reason code when they may not.
 */
export function checkContentType(
  bytes: Uint8Array,
  declaredType: string,
  fileName: string,
): { ok: true } | { ok: false; reason: 'content_mime_mismatch' | 'name_extension_mismatch' } {
  if (!extensionMatches(fileName, declaredType)) return { ok: false, reason: 'name_extension_mismatch' };

  const sniffed = sniffContent(bytes);
  if (!sniffed) return { ok: true };
  // Plain text carries no signature: text bytes cannot be a disguised executable,
  // so they never contradict a declared type on their own.
  if (sniffed.kind === 'text') return { ok: true };

  if (sniffed.type === declaredType) return { ok: true };
  // OOXML documents are ZIP containers; the extension already identified them.
  if (sniffed.type === 'application/zip' && OOXML_TYPES.has(declaredType)) return { ok: true };

  return { ok: false, reason: 'content_mime_mismatch' };
}
