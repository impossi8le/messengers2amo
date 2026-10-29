import type { OutboundMediaReference } from './outbound-media.ts';
import { isCrmAttachmentUrl } from './outbound-media.ts';
import { sanitizeFileName } from '../../media/policy.ts';

export type CrmReplyContent = { text: string; media?: OutboundMediaReference };

/** One native v2 message is one send intent, including one optional attachment. */
export function readCrmReplyContent(message: Record<string, unknown>): CrmReplyContent | null {
  if (message.forwards || message.markup || message.template) return null;
  const text = message.text === undefined ? '' : message.text;
  if (typeof text !== 'string') return null;
  if (message.type === 'text') {
    return text.length > 0 && text.length <= 4096 && !message.media ? { text } : null;
  }
  if (message.type !== 'picture' && message.type !== 'file') return null;
  if (text.length > 1024 || typeof message.media !== 'string' || !isCrmAttachmentUrl(message.media)) return null;
  const type = message.type === 'picture' ? 'photo' : 'document';
  const size = message.file_size;
  const limit = (type === 'photo' ? 10 : 20) * 1024 * 1024;
  if (size !== undefined && (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 || size > limit)) return null;
  if (message.file_name !== undefined && typeof message.file_name !== 'string') return null;
  const fileName = sanitizeFileName(typeof message.file_name === 'string' && message.file_name.trim()
    ? message.file_name : type === 'photo' ? 'photo.jpg' : 'attachment.bin');
  const extension = fileName.split('.').pop()?.toLowerCase();
  const mimeType = extension === 'png' ? 'image/png' : ['jpg', 'jpeg'].includes(extension ?? '') ? 'image/jpeg'
    : extension === 'webp' ? 'image/webp' : extension === 'txt' ? 'text/plain' : extension === 'pdf' ? 'application/pdf'
      : type === 'photo' ? 'image/jpeg' : 'application/octet-stream';
  return { text, media: { type, url: message.media, fileName, mimeType, sizeBytes: typeof size === 'number' && size > 0 ? size : null } };
}

export function readStoredCrmReplyContent(value: unknown): CrmReplyContent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const content = value as Record<string, unknown>;
  if (!content.media) return readCrmReplyContent({ type: 'text', text: content.text });
  if (typeof content.media !== 'object' || Array.isArray(content.media)) return null;
  const media = content.media as Record<string, unknown>;
  if (media.type !== 'photo' && media.type !== 'document') return null;
  return readCrmReplyContent({ type: media.type === 'photo' ? 'picture' : 'file', text: content.text,
    media: media.url, file_name: media.fileName, file_size: media.sizeBytes ?? undefined });
}
