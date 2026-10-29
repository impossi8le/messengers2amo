import { AmocrmApiError, createAmocrmClient } from './client.ts';

export type CrmDirectoryUser = {
  id: string;
  name: string;
  isActive: boolean;
  isAdmin: boolean;
  groupId: string | null;
  groupName: string | null;
  roleId: string | null;
  roleName: string | null;
  amojoId: string | null;
};

export type CrmDirectoryRole = { id: string; name: string };

export type CrmDirectorySnapshot = { users: CrmDirectoryUser[]; roles: CrmDirectoryRole[] };

export type CrmDirectoryScope = { companyId: string; accountId: string };

export type CrmDirectoryClientOptions = {
  accountDomain: string;
  getAccessToken: (scope: CrmDirectoryScope) => Promise<string>;
  fetch: typeof fetch;
  apiBase?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
};

export type CrmDirectoryClient = {
  load(input: CrmDirectoryScope): Promise<CrmDirectorySnapshot>;
};

const PAGE_SIZE = 250;
const MAX_PAGES = 20;

function invalidResponse(): never {
  throw new AmocrmApiError(200, 'directory_invalid_response');
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidResponse();
  return value as Record<string, unknown>;
}

function positiveId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return invalidResponse();
  return value;
}

function nullableId(value: unknown): number | null {
  return value === undefined || value === null ? null : positiveId(value);
}

function name(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 512) return invalidResponse();
  return value;
}

function nullableAmojoId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 128) return invalidResponse();
  return value;
}

function relationName(embeddedValue: unknown, key: 'roles' | 'groups', id: number | null): string | null {
  if (id === null) return null;
  if (embeddedValue === undefined || embeddedValue === null) return invalidResponse();
  const embedded = record(embeddedValue);
  const values = embedded[key];
  if (!Array.isArray(values)) return invalidResponse();
  let matched: string | null = null;
  for (const value of values) {
    const relation = record(value);
    const relationId = positiveId(relation.id);
    const relationNameValue = name(relation.name);
    if (relationId === id) {
      if (matched !== null) return invalidResponse();
      matched = relationNameValue;
    }
  }
  if (matched === null) return invalidResponse();
  return matched;
}

function parseUser(value: unknown): CrmDirectoryUser {
  const item = record(value);
  const id = positiveId(item.id);
  const userName = name(item.name);
  const rights = record(item.rights);
  if (typeof rights.is_active !== 'boolean' || typeof rights.is_admin !== 'boolean') return invalidResponse();
  const roleId = nullableId(rights.role_id);
  const groupId = nullableId(rights.group_id);
  return {
    id: String(id),
    name: userName,
    isActive: rights.is_active,
    isAdmin: rights.is_admin,
    groupId: groupId === null ? null : String(groupId),
    groupName: relationName(item._embedded, 'groups', groupId),
    roleId: roleId === null ? null : String(roleId),
    roleName: relationName(item._embedded, 'roles', roleId),
    amojoId: nullableAmojoId(item.amojo_id),
  };
}

function parseRole(value: unknown): CrmDirectoryRole {
  const item = record(value);
  return { id: String(positiveId(item.id)), name: name(item.name) };
}

async function loadCollection<T>(
  request: <R>(path: string) => Promise<R>,
  pathForPage: (page: number) => string,
  key: 'users' | 'roles',
  parse: (value: unknown) => T,
): Promise<T[]> {
  const values: T[] = [];
  const ids = new Set<string>();
  let requiredPage = false;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const payloadValue = await request<unknown>(pathForPage(page));
    // Only HTTP 204 is an empty terminal response. JSON null is malformed, and
    // an explicitly advertised next page cannot disappear without a full refresh.
    if (payloadValue === undefined) {
      if (requiredPage) return invalidResponse();
      return values;
    }
    const payload = record(payloadValue);
    const embedded = record(payload._embedded);
    const pageValues = embedded[key];
    if (!Array.isArray(pageValues) || pageValues.length > PAGE_SIZE) return invalidResponse();

    const parsed = pageValues.map(parse);
    for (const entry of parsed) {
      const id = (entry as { id: string }).id;
      if (ids.has(id)) return invalidResponse();
      ids.add(id);
      values.push(entry);
    }

    let hasNext: boolean;
    if (payload._page_count !== undefined) {
      const pageCount = payload._page_count;
      if (typeof pageCount !== 'number' || !Number.isSafeInteger(pageCount) || pageCount < page) return invalidResponse();
      hasNext = page < pageCount;
      requiredPage = hasNext;
    } else {
      if (payload._links !== undefined) {
        const links = record(payload._links);
        if (links.next !== undefined && links.next !== null) record(links.next);
      }
      const links = payload._links as Record<string, unknown> | undefined;
      requiredPage = links?.next !== undefined && links.next !== null;
      hasNext = requiredPage || pageValues.length === PAGE_SIZE;
    }
    if (!hasNext) return values;
    if (page === MAX_PAGES) throw new AmocrmApiError(0, 'directory_page_limit_exceeded');
  }
  return values;
}

export function createCrmDirectoryClient(options: CrmDirectoryClientOptions): CrmDirectoryClient {
  return {
    async load(input): Promise<CrmDirectorySnapshot> {
      const client = createAmocrmClient({
        accountDomain: options.accountDomain,
        getAccessToken: () => options.getAccessToken(input),
        fetch: options.fetch,
        apiBase: options.apiBase,
        timeoutMs: options.timeoutMs,
        maxResponseBytes: options.maxResponseBytes,
      });
      const request = async <T>(path: string): Promise<T> => {
        try {
          return await client.request<T>(path);
        } catch (error) {
          if (error instanceof AmocrmApiError && error.status === 200 && error.code === 'invalid_json') {
            return invalidResponse();
          }
          throw error;
        }
      };
      const users = await loadCollection(
        request,
        (page) => `/api/v4/users?with=role,group,amojo_id&page=${page}&limit=${PAGE_SIZE}`,
        'users',
        parseUser,
      );
      const roles = await loadCollection(
        request,
        (page) => `/api/v4/roles?page=${page}&limit=${PAGE_SIZE}`,
        'roles',
        parseRole,
      );
      return { users, roles };
    },
  };
}
