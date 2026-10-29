import { sanitizeFileName } from '../media/policy.ts';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type TelegramCommand =
  | { commandType: 'send_text'; chatId: string; text: string; replyToMessageId?: string }
  | {
      commandType: 'send_media';
      chatId: string;
      mediaType: 'photo' | 'document' | 'video' | 'audio' | 'voice' | 'animation' | 'sticker' | 'video_note';
      file: { bytes: Uint8Array; fileName: string; mimeType: string };
      caption?: string;
      replyToMessageId?: string;
    }
  | { commandType: 'edit_text'; chatId: string; messageId: string; text: string }
  | { commandType: 'edit_caption'; chatId: string; messageId: string; caption: string }
  | { commandType: 'delete'; chatId: string; messageId: string }
  | { commandType: 'reaction'; chatId: string; messageId: string; emoji: string | null }
  | { commandType: 'typing'; chatId: string };

export type CommandOutcome =
  | { outcome: 'sent'; providerMessageId: string }
  | { outcome: 'applied' }
  | { outcome: 'failed'; code: string }
  | { outcome: 'rate_limited'; retryAfterSeconds: number }
  | { outcome: 'unknown'; reason: 'timeout' | 'network' | 'http_5xx' | 'malformed' };

export type TelegramCommandTransport = {
  execute: (command: TelegramCommand) => Promise<CommandOutcome>;
};

export type CommandTransportOptions = {
  fetch: FetchLike;
  apiBase: string;
  botToken: string;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_LENGTH = 4096;
const MAX_CAPTION_LENGTH = 1024;

const MEDIA_METHODS = {
  photo: { method: 'sendPhoto', field: 'photo' },
  document: { method: 'sendDocument', field: 'document' },
  video: { method: 'sendVideo', field: 'video' },
  audio: { method: 'sendAudio', field: 'audio' },
  voice: { method: 'sendVoice', field: 'voice' },
  animation: { method: 'sendAnimation', field: 'animation' },
  sticker: { method: 'sendSticker', field: 'sticker' },
  video_note: { method: 'sendVideoNote', field: 'video_note' },
} as const;

type MediaType = keyof typeof MEDIA_METHODS;

function parseBody(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isPositiveMessageId(value: string | number): boolean {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(num) && num > 0 && String(num) === String(value);
}

function isValidChatId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function validateCommand(command: TelegramCommand): CommandOutcome | null {
  if (!isValidChatId(command.chatId)) {
    return { outcome: 'failed', code: 'invalid_chat_id' };
  }

  switch (command.commandType) {
    case 'send_text': {
      if (typeof command.text !== 'string' || command.text.length === 0 || command.text.length > MAX_TEXT_LENGTH) {
        return { outcome: 'failed', code: 'text_too_long' };
      }
      if (command.replyToMessageId !== undefined && !isPositiveMessageId(command.replyToMessageId)) {
        return { outcome: 'failed', code: 'invalid_message_id' };
      }
      return null;
    }
    case 'send_media': {
      const mediaType = command.mediaType;
      if (!mediaType || !MEDIA_METHODS[mediaType as MediaType]) {
        return { outcome: 'failed', code: 'invalid_media_type' };
      }
      const file = command.file;
      if (!file || !(file.bytes instanceof Uint8Array) || file.bytes.length === 0) {
        return { outcome: 'failed', code: 'missing_file' };
      }
      if (file.bytes.length > MAX_MEDIA_BYTES) {
        return { outcome: 'failed', code: 'media_too_large' };
      }
      if (typeof file.fileName !== 'string' || file.fileName.length === 0) {
        return { outcome: 'failed', code: 'missing_file_name' };
      }
      if (typeof file.mimeType !== 'string' || file.mimeType.length === 0) {
        return { outcome: 'failed', code: 'missing_mime_type' };
      }
      if (command.caption !== undefined) {
        if (mediaType === 'sticker' || mediaType === 'video_note') {
          return { outcome: 'failed', code: 'caption_not_allowed' };
        }
        if (typeof command.caption !== 'string' || command.caption.length > MAX_CAPTION_LENGTH) {
          return { outcome: 'failed', code: 'caption_too_long' };
        }
      }
      if (command.replyToMessageId !== undefined && !isPositiveMessageId(command.replyToMessageId)) {
        return { outcome: 'failed', code: 'invalid_message_id' };
      }
      return null;
    }
    case 'edit_text': {
      if (typeof command.text !== 'string' || command.text.length === 0 || command.text.length > MAX_TEXT_LENGTH) {
        return { outcome: 'failed', code: 'text_too_long' };
      }
      if (!isPositiveMessageId(command.messageId)) {
        return { outcome: 'failed', code: 'invalid_message_id' };
      }
      return null;
    }
    case 'edit_caption': {
      if (typeof command.caption !== 'string' || command.caption.length === 0 || command.caption.length > MAX_CAPTION_LENGTH) {
        return { outcome: 'failed', code: 'caption_too_long' };
      }
      if (!isPositiveMessageId(command.messageId)) {
        return { outcome: 'failed', code: 'invalid_message_id' };
      }
      return null;
    }
    case 'delete':
    case 'reaction': {
      if (!isPositiveMessageId(command.messageId)) {
        return { outcome: 'failed', code: 'invalid_message_id' };
      }
      return null;
    }
    case 'typing': {
      return null;
    }
    default: {
      const _exhaustive: never = command;
      void _exhaustive;
      return { outcome: 'failed', code: 'invalid_command' };
    }
  }
}

function replyParameters(messageId: string): Record<string, unknown> {
  return { message_id: Number(messageId), allow_sending_without_reply: false };
}

function buildPayload(
  command: TelegramCommand,
): { body: RequestInit['body']; headers?: Record<string, string> } {
  switch (command.commandType) {
    case 'send_text': {
      const payload: Record<string, unknown> = { chat_id: command.chatId, text: command.text };
      if (command.replyToMessageId !== undefined) {
        payload.reply_parameters = replyParameters(command.replyToMessageId);
      }
      return { body: JSON.stringify(payload), headers: { 'content-type': 'application/json' } };
    }
    case 'send_media': {
      const field = MEDIA_METHODS[command.mediaType as MediaType].field;
      const form = new FormData();
      form.append('chat_id', command.chatId);
      form.append(
        field,
        new Blob([command.file.bytes], { type: command.file.mimeType }),
        sanitizeFileName(command.file.fileName),
      );
      if (command.caption !== undefined && command.mediaType !== 'sticker' && command.mediaType !== 'video_note') {
        form.append('caption', command.caption);
      }
      if (command.replyToMessageId !== undefined) {
        form.append('reply_parameters', JSON.stringify(replyParameters(command.replyToMessageId)));
      }
      return { body: form };
    }
    case 'edit_text': {
      return {
        body: JSON.stringify({ chat_id: command.chatId, message_id: Number(command.messageId), text: command.text }),
        headers: { 'content-type': 'application/json' },
      };
    }
    case 'edit_caption': {
      return {
        body: JSON.stringify({
          chat_id: command.chatId,
          message_id: Number(command.messageId),
          caption: command.caption,
        }),
        headers: { 'content-type': 'application/json' },
      };
    }
    case 'delete': {
      return {
        body: JSON.stringify({ chat_id: command.chatId, message_id: Number(command.messageId) }),
        headers: { 'content-type': 'application/json' },
      };
    }
    case 'reaction': {
      const reaction = command.emoji === null ? [] : [{ type: 'emoji', emoji: command.emoji }];
      return {
        body: JSON.stringify({ chat_id: command.chatId, message_id: Number(command.messageId), reaction }),
        headers: { 'content-type': 'application/json' },
      };
    }
    case 'typing': {
      return {
        body: JSON.stringify({ chat_id: command.chatId, action: 'typing' }),
        headers: { 'content-type': 'application/json' },
      };
    }
    default: {
      const _exhaustive: never = command;
      throw new Error(`unsupported_command: ${_exhaustive}`);
    }
  }
}

function methodForCommand(command: TelegramCommand): string {
  switch (command.commandType) {
    case 'send_text':
      return 'sendMessage';
    case 'send_media':
      return MEDIA_METHODS[command.mediaType as MediaType].method;
    case 'edit_text':
      return 'editMessageText';
    case 'edit_caption':
      return 'editMessageCaption';
    case 'delete':
      return 'deleteMessage';
    case 'reaction':
      return 'setMessageReaction';
    case 'typing':
      return 'sendChatAction';
    default: {
      const _exhaustive: never = command;
      throw new Error(`unsupported_command: ${_exhaustive}`);
    }
  }
}

function isSendCommand(commandType: string): boolean {
  return commandType === 'send_text' || commandType === 'send_media';
}

async function readBounded(response: Response, signal: AbortSignal): Promise<string | null> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
    await response.body?.cancel().catch(() => {});
    return null;
  }

  const reader = response.body?.getReader();
  if (!reader) return '';

  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(part.value);
    }
  } catch {
    await reader.cancel().catch(() => {});
    return null;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

function classifyOutcome(response: Response, raw: string | null, commandType: string): CommandOutcome {
  if (response.status >= 500) {
    return { outcome: 'unknown', reason: 'http_5xx' };
  }

  const parsed = parseBody(raw ?? '');

  if (response.status === 429) {
    const parameters = parsed?.parameters;
    const retryAfter =
      parameters && typeof parameters === 'object'
        ? (parameters as Record<string, unknown>).retry_after
        : undefined;
    if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0) {
      return { outcome: 'rate_limited', retryAfterSeconds: retryAfter };
    }
    return { outcome: 'failed', code: 'rate_limit_unconfirmed' };
  }

  if (!parsed) {
    return { outcome: 'unknown', reason: 'malformed' };
  }

  if (response.ok && parsed.ok === true) {
    if (isSendCommand(commandType)) {
      const result = parsed.result;
      const messageId = result && typeof result === 'object' ? (result as Record<string, unknown>).message_id : undefined;
      if ((typeof messageId === 'number' || typeof messageId === 'string') && isPositiveMessageId(messageId)) {
        return { outcome: 'sent', providerMessageId: String(messageId) };
      }
      return { outcome: 'unknown', reason: 'malformed' };
    }
    return { outcome: 'applied' };
  }

  if (parsed.ok === false) {
    const code = parsed.error_code;
    return { outcome: 'failed', code: typeof code === 'number' ? `provider_${code}` : 'provider_rejected' };
  }

  return { outcome: 'unknown', reason: 'malformed' };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/**
 * Bounded Telegram command transport. Executes exactly one Bot API request per
 * command: no redirects, no retries, and no follow-up on ambiguous outcomes.
 * Provider credentials and URLs are never surfaced in returned outcomes or
 * thrown errors.
 */
export function createTelegramCommandTransport(options: CommandTransportOptions): TelegramCommandTransport {
  const base = new URL(options.apiBase);
  if (base.protocol !== 'https:') {
    throw new Error('telegram_api_base_must_be_https');
  }
  if (!options.botToken) {
    throw new Error('telegram_bot_token_required');
  }
  const origin = base.toString().replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async execute(command: TelegramCommand): Promise<CommandOutcome> {
      const validation = validateCommand(command);
      if (validation) return validation;

      const method = methodForCommand(command);
      const endpoint = `${origin}/bot${options.botToken}/${method}`;
      const { body, headers } = buildPayload(command);
      const signal = AbortSignal.timeout(timeoutMs);

      let response: Response;
      let raw: string | null;
      try {
        response = await options.fetch(endpoint, {
          method: 'POST',
          headers,
          body,
          redirect: 'error',
          signal,
        });
        raw = await readBounded(response, signal);
      } catch (error) {
        if (signal.aborted || isAbortError(error)) {
          return { outcome: 'unknown', reason: 'timeout' };
        }
        return { outcome: 'unknown', reason: 'network' };
      }

      return classifyOutcome(response, raw, command.commandType);
    },
  };
}
