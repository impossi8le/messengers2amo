import { AmocrmApiError, AuthRequiredError } from './client.ts';
import { AuthRevokedError } from './oauth.ts';
import { fetchBounded, deadlineOptions, HttpDeadlineError, HttpResponseTooLargeError } from './deadline.ts';

type Scope = { companyId: string; accountId: string };
type LinkInput = Scope & { leadId: string; fileUuid: string };
export interface CrmFilesClient {
  upload(input: Scope & { fileName: string; mimeType: string; bytes: Uint8Array }): Promise<{ uuid: string }>;
  isLinked(input: LinkInput): Promise<boolean>;
  link(input: LinkInput): Promise<void>;
}
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_PARTS = 4096;
const MAX_PAGES = 100;
const PAGE_SIZE = 250;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function invalidResponse(): never { throw new AmocrmApiError(0, 'files_invalid_response'); }
function invalidInput(): never { throw new AmocrmApiError(0, 'files_invalid_input'); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidResponse();
  return value as Record<string, unknown>;
}
function positiveInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return invalidResponse();
  return value;
}
function driveOrigin(value: unknown): string {
  if (typeof value !== 'string') return invalidResponse();
  let url: URL;
  try { url = new URL(value); } catch { return invalidResponse(); }
  if (url.protocol !== 'https:' || !/^drive(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?\.amocrm\.ru$/.test(url.hostname) ||
      url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return invalidResponse();
  return url.origin;
}
function uploadUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 8192) return invalidResponse();
  let url: URL;
  try { url = new URL(value); } catch { return invalidResponse(); }
  // Session allocation and byte upload may use different amoCRM drive shards.
  // Validate the vendor-controlled HTTPS origin before forwarding any credential.
  driveOrigin(url.origin);
  if (url.username || url.password || url.search || url.hash ||
      !/^\/(?:v1\.0\/sessions\/)?upload\/[a-zA-Z0-9._-]+$/.test(url.pathname)) return invalidResponse();
  return url.toString();
}
function validateLink(input: LinkInput): void {
  if (!/^[1-9][0-9]*$/.test(input.leadId) || !Number.isSafeInteger(Number(input.leadId)) || !UUID.test(input.fileUuid)) invalidInput();
}

/** One HTTP attempt per call. The durable caller owns reconciliation and retries. */
export function createCrmFilesClient(options: {
  accountDomain: string; getAccessToken: (scope: Scope) => Promise<string>; fetch: typeof fetch; timeoutMs?: number;
}): CrmFilesClient {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.amocrm\.ru$/i.test(options.accountDomain)) invalidInput();
  const apiOrigin = `https://${options.accountDomain}`;
  const limits = deadlineOptions({ timeoutMs: options.timeoutMs, maxResponseBytes: 1024 * 1024 });
  if (!Number.isSafeInteger(limits.timeoutMs) || limits.timeoutMs < 1) invalidInput();
  const request = async (scope: Scope, url: string, init: RequestInit = {}, accepted = [200]): Promise<unknown> => {
    let token: string;
    try { token = await options.getAccessToken({ companyId: scope.companyId, accountId: scope.accountId }); }
    catch (error) {
      if (error instanceof AuthRequiredError) throw new AuthRequiredError();
      if (error instanceof AuthRevokedError) throw new AuthRevokedError();
      throw new AmocrmApiError(0, 'files_auth_unavailable');
    }
    let response: Awaited<ReturnType<typeof fetchBounded>> | undefined;
    try {
      const headers = new Headers(init.headers);
      headers.set('authorization', `Bearer ${token}`);
      headers.set('accept', 'application/json');
      response = await fetchBounded(options.fetch, url, { ...init, headers, redirect: 'error' }, limits);
      // Read even error/empty bodies through the same bounded deadline, never expose them.
      const payload = await response.json();
      if (response.status === 401) throw new AuthRequiredError();
      if (!accepted.includes(response.status)) throw new AmocrmApiError(response.status, `files_http_${response.status}`);
      if (response.status === 204 || response.status === 202) return null;
      if (payload === undefined || payload === null) return invalidResponse();
      return payload;
    } catch (error) {
      if (error instanceof AmocrmApiError || error instanceof AuthRequiredError) throw error;
      if (error instanceof HttpDeadlineError) throw new AmocrmApiError(0, 'files_timeout');
      if (error instanceof HttpResponseTooLargeError) throw new AmocrmApiError(0, 'files_response_too_large');
      throw new AmocrmApiError(0, 'files_network_error');
    } finally { response?.close(); }
  };
  return {
    async upload(input) {
      if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength > MAX_FILE_BYTES ||
          typeof input.fileName !== 'string' || !input.fileName.trim() || input.fileName.length > 1024 ||
          /[\u0000-\u001f\u007f]/.test(input.fileName) || typeof input.mimeType !== 'string' ||
          !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+(?:;[\x20-\x7e]+)?$/.test(input.mimeType) || input.mimeType.length > 256) invalidInput();
      const account = record(await request(input, `${apiOrigin}/api/v4/account?with=drive_url`));
      const origin = driveOrigin(account.drive_url);
      const session = record(await request(input, `${origin}/v1.0/sessions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file_name: input.fileName, file_size: input.bytes.byteLength, content_type: input.mimeType, with_preview: input.mimeType!=='application/octet-stream' }),
      }));
      const sessionId = positiveInteger(session.session_id);
      const partSize = positiveInteger(session.max_part_size);
      if (positiveInteger(session.max_file_size) < input.bytes.byteLength) return invalidResponse();
      const parts = Math.max(1, Math.ceil(input.bytes.byteLength / partSize));
      if (parts > MAX_PARTS) return invalidResponse();
      let next = uploadUrl(session.upload_url);
      const visited = new Set<string>();
      for (let part = 0; part < parts; part++) {
        if (visited.has(next)) return invalidResponse();
        visited.add(next);
        const result = record(await request(input, next, { method: 'POST', headers: { 'content-type': 'application/octet-stream' },
          body: Buffer.from(input.bytes.subarray(part * partSize, Math.min(input.bytes.byteLength, (part + 1) * partSize))),
        }));
        if (result.session_id !== undefined && result.session_id !== sessionId) return invalidResponse();
        if (part === parts - 1) {
          if (typeof result.uuid !== 'string' || !UUID.test(result.uuid) || result.next_url !== undefined ||
              (result.size !== undefined && result.size !== input.bytes.byteLength) || result.is_trashed === true) return invalidResponse();
          return { uuid: result.uuid };
        }
        if (result.uuid !== undefined || result.session_id !== sessionId) return invalidResponse();
        next = uploadUrl(result.next_url);
      }
      return invalidResponse();
    },
    async isLinked(input) {
      validateLink(input);
      let before: number | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const path = `${apiOrigin}/api/v4/leads/${input.leadId}/files?limit=${PAGE_SIZE}${before === undefined ? '' : `&before_id=${before}`}`;
        const payload = await request(input, path, {}, [200, 204]);
        if (payload === null) return false;
        const files = record(record(payload)._embedded).files;
        if (!Array.isArray(files) || files.length > PAGE_SIZE) return invalidResponse();
        const ids = new Set<number>();
        let found = false;
        for (const value of files) {
          const file = record(value);
          const id = positiveInteger(file.id);
          if (ids.has(id) || (before !== undefined && id >= before) || typeof file.file_uuid !== 'string' || !UUID.test(file.file_uuid)) return invalidResponse();
          ids.add(id);
          if (file.file_uuid.toLowerCase() === input.fileUuid.toLowerCase()) found = true;
        }
        if (found) return true;
        if (files.length < PAGE_SIZE) return false;
        before = Math.min(...ids);
      }
      throw new AmocrmApiError(0, 'files_page_limit_exceeded');
    },
    async link(input) {
      validateLink(input);
      await request(input, `${apiOrigin}/api/v4/leads/${input.leadId}/files`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify([{ file_uuid: input.fileUuid }]),
      }, [202]);
    },
  };
}
