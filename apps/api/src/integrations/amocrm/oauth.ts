import { randomBytes } from 'node:crypto';
import type { Db } from '../../platform/db.ts';
import { withTransaction } from '../../platform/db.ts';
import { logEvent } from '../../platform/logger.ts';
import type { TokenCipher } from './crypto.ts';
import {
  deadlineOptions,
  fetchBounded,
  HttpDeadlineError,
  HttpResponseTooLargeError,
  type DeadlineOptions,
} from './deadline.ts';
import {
  loadAccount,
  listChannelsByAccount,
  qualified,
  recordOauthAudit,
  setAccountState,
  writeAccountCredentials,
  type StoredCredentials,
} from './store.ts';
import { raiseAlert, disableChannelAndAlert } from '../../channels/alerts.ts';

export type OAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  accountDomain: string;
  tokenEndpoint?: string;
};

export type OAuthDeps = {
  db: Db;
  schema?: string;
  config: OAuthConfig;
  cipher: TokenCipher;
  fetch: typeof fetch;
  now?: () => number;
  notify?: (event: string, fields: Record<string, unknown>) => void;
  /** Deadline for one token-endpoint call, headers and body included. */
  timeoutMs?: number;
  /** Hard cap on a token-endpoint response body. */
  maxResponseBytes?: number;
};

export class OAuthError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = 'OAuthError';
    this.code = code;
  }
}

export class AuthRevokedError extends Error {
  readonly code = 'amocrm_auth_revoked';
  constructor(message = 'amocrm_auth_revoked') {
    super(message);
    this.name = 'AuthRevokedError';
  }
}

export class RateLimitError extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number, message = 'amocrm_rate_limited') {
    super(message);
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

export type OAuthService = {
  /**
   * Registered callback URL. The console origin used as the postMessage target
   * is derived from it, so it is never hardcoded in the callback page.
   */
  redirectUri?: string;
  authorizationUrl: (input: { companyId: string; accountId: string }) => Promise<{ url: string; state: string }>;
  complete: (input: {
    /**
     * Optional assertion, never the binding: the company that completes an
     * exchange is the one stored on the state row. Naming a different company
     * rejects the call without consuming the state.
     */
    companyId?: string;
    code: string;
    state: string;
    accountDomain?: string;
    redirectUri?: string;
  }) => Promise<{ accountId: string; tokens: StoredCredentials }>;
  refresh: (input: { companyId: string; accountId: string; force?: boolean }) => Promise<StoredCredentials>;
  accessToken: (input: { companyId: string; accountId: string }) => Promise<string>;
  revoke: (input: { companyId: string; accountId: string; reason: string }) => Promise<void>;
};

const STATE_TTL_MS = 10 * 60 * 1000;
const REFRESH_SKEW_MS = 60 * 1000;

function normalizeDomain(value: string): string {
  if (typeof value !== 'string') throw new OAuthError('invalid_account_domain');
  const domain = value.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
    throw new OAuthError('invalid_account_domain');
  }
  if (domain.length > 253) throw new OAuthError('invalid_account_domain');
  return domain;
}

function parseRetryAfter(header: string | null, now: number): number {
  if (!header) return 1000;
  const seconds = Number.parseInt(header, 10);
  if (Number.isFinite(seconds) && String(seconds) === header.trim()) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return 1000;
}

function parseTokens(value: unknown): StoredCredentials | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const accessToken = record.access_token;
  const refreshToken = record.refresh_token;
  const expiresIn = record.expires_in;
  if (typeof accessToken !== 'string' || accessToken.length === 0) return null;
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) return null;
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) return null;
  return {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
    tokenType: typeof record.token_type === 'string' ? record.token_type : 'Bearer',
    accountDomain: '',
  };
}

function envelopeOf(cipher: TokenCipher, credentials: StoredCredentials, refreshedAt: number): string {
  return cipher.encrypt(JSON.stringify({ ...credentials, refreshedAt }));
}

function decodeEnvelope(cipher: TokenCipher, envelope: string): StoredCredentials & { refreshedAt: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(cipher.decrypt(envelope));
  } catch {
    throw new OAuthError('invalid_credential_envelope');
  }
  if (!parsed || typeof parsed !== 'object') throw new OAuthError('invalid_credential_envelope');
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.accessToken !== 'string' ||
    typeof record.refreshToken !== 'string' ||
    typeof record.expiresAt !== 'number'
  ) {
    throw new OAuthError('invalid_credential_envelope');
  }
  return {
    accessToken: record.accessToken,
    refreshToken: record.refreshToken,
    expiresAt: record.expiresAt,
    tokenType: typeof record.tokenType === 'string' ? record.tokenType : 'Bearer',
    accountDomain: typeof record.accountDomain === 'string' ? record.accountDomain : '',
    refreshedAt: typeof record.refreshedAt === 'number' ? record.refreshedAt : 0,
  };
}

export function createOAuth(deps: OAuthDeps): OAuthService {
  const domain = normalizeDomain(deps.config.accountDomain);
  const tokenEndpoint = deps.config.tokenEndpoint ?? `https://${domain}/oauth2/access_token`;
  const now = deps.now ?? (() => Date.now());
  const deadline: DeadlineOptions = deadlineOptions({
    timeoutMs: deps.timeoutMs,
    maxResponseBytes: deps.maxResponseBytes,
  });
  const notify =
    deps.notify ??
    ((event: string, fields: Record<string, unknown>) => {
      logEvent('warn', event, fields);
    });

  // In-process serialization per account. The database row lock below covers
  // other processes; both are required for a single refresh exchange.
  const tails = new Map<string, Promise<unknown>>();

  async function withAccountLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = tails.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    tails.set(key, tail);
    try {
      return await run;
    } finally {
      if (tails.get(key) === tail) tails.delete(key);
    }
  }

  /**
   * Alerts the administrator of every channel of an account that a refresh
   * problem concerns.
   *
   * A CRM account may register several chat channels, and each of them is a
   * separate messenger connection with its own alert recipient. The alert is
   * addressed through the route of the connection, so the recipient is never
   * guessed here.
   *
   * The dedupe key names the account and the reason, not the error text: a
   * repeated refresh failure for the same account is the same event.
   */
  async function alertAccountChannels(
    input: { companyId: string; accountId: string },
    kind: 'refresh_exhausted' | 'channel_disabled',
    errorCode: 'TOKEN_REFRESH_FAILED' | 'ACCESS_REVOKED',
    dedupeSuffix: string,
  ): Promise<void> {
    const channels = await listChannelsByAccount(deps.db, deps.schema, {
      companyId: input.companyId,
      accountId: input.accountId,
    });
    for (const channel of channels) {
      await raiseAlert(deps.db, { schema: deps.schema ?? 'public' }, {
        companyId: input.companyId,
        connectionId: channel.connection_id,
        kind,
        dedupeKey: `${kind}:${input.accountId}:${channel.connection_id}:${dedupeSuffix}`,
        errorCode,
      });
    }
  }

  async function postToken(body: Record<string, string>): Promise<StoredCredentials> {
    let response: Awaited<ReturnType<typeof fetchBounded>>;
    try {
      response = await fetchBounded(
        deps.fetch,
        tokenEndpoint,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
        },
        deadline,
      );
    } catch (error) {
      if (error instanceof HttpDeadlineError) throw new OAuthError('token_endpoint_timeout');
      if (error instanceof HttpResponseTooLargeError) throw new OAuthError('token_response_too_large');
      throw new OAuthError('token_endpoint_unavailable');
    }
    if (response.status === 429) {
      response.close();
      throw new RateLimitError(parseRetryAfter(response.headers.get('retry-after'), now()));
    }
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch (error) {
      if (error instanceof HttpDeadlineError) throw new OAuthError('token_endpoint_timeout');
      if (error instanceof HttpResponseTooLargeError) throw new OAuthError('token_response_too_large');
      payload = null;
    }
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      const errorCode =
        payload && typeof payload === 'object' && typeof (payload as Record<string, unknown>).error === 'string'
          ? String((payload as Record<string, unknown>).error)
          : '';
      if (errorCode === 'invalid_grant' || errorCode === 'invalid_client' || response.status === 401) {
        throw new AuthRevokedError();
      }
      throw new OAuthError('token_exchange_rejected');
    }
    if (response.status < 200 || response.status >= 300) throw new OAuthError('token_endpoint_unavailable');
    const tokens = parseTokens(payload);
    if (!tokens) throw new OAuthError('invalid_token_response');
    tokens.accountDomain = domain;
    return tokens;
  }

  return {
    redirectUri: deps.config.redirectUri,

    async authorizationUrl(input) {
      const nonce = randomBytes(24).toString('base64url');
      // First connection bootstraps the tenant and its CRM account row, which the
      // OAuth state row references. Both statements are idempotent.
      await deps.db.query(
        `INSERT INTO ${qualified(deps.schema, 'companies')}(id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
        [input.companyId],
      );
      await deps.db.query(
        `INSERT INTO ${qualified(deps.schema, 'crm_accounts')}(company_id,id,state) VALUES ($1,$2,'setup')
         ON CONFLICT (company_id,id) DO NOTHING`,
        [input.companyId, input.accountId],
      );
      await deps.db.query(
        `INSERT INTO ${qualified(deps.schema, 'amocrm_oauth_states')}
           (company_id,account_id,nonce,account_domain,redirect_uri)
         VALUES ($1,$2,$3,$4,$5)`,
        [input.companyId, input.accountId, nonce, domain, deps.config.redirectUri],
      );
      // The consent page is served from the shared www.amocrm.ru host. The account
      // subdomain answers /oauth2/authorize with 405; it is only used later, for the
      // token endpoint.
      const url = new URL('https://www.amocrm.ru/oauth');
      url.searchParams.set('client_id', deps.config.clientId);
      url.searchParams.set('state', nonce);
      // mode is mandatory: without it the consent page answers 403. post_message
      // makes amoCRM redirect inside the popup; our callback page posts the result
      // to the opener and closes itself, so the console stays in place. popup mode
      // would try to close the window and navigate the main tab instead.
      url.searchParams.set('mode', 'post_message');
      return { url: url.toString(), state: nonce };
    },

    async complete(input) {
      if (input.accountDomain !== undefined && normalizeDomain(input.accountDomain) !== domain) {
        throw new OAuthError('unexpected_account_domain');
      }
      if (input.redirectUri !== undefined && input.redirectUri !== deps.config.redirectUri) {
        throw new OAuthError('unexpected_redirect_uri');
      }
      if (typeof input.code !== 'string' || input.code.length === 0) {
        throw new OAuthError('invalid_authorization_code');
      }
      // Single use: consume before the exchange, so a replayed state cannot
      // trigger a second code exchange even if the first one failed. The state
      // row, not the caller, decides which company receives the tokens: the
      // callback is a top-level navigation from amoCRM and carries no console
      // session, so a company from configuration may name a different tenant
      // than the one that authorized.
      const consumed = await deps.db.query<{
        company_id: string;
        account_id: string;
        account_domain: string;
        redirect_uri: string;
      }>(
        `UPDATE ${qualified(deps.schema, 'amocrm_oauth_states')}
            SET consumed_at=now()
          WHERE nonce=$2 AND ($1::text IS NULL OR company_id=$1)
            AND consumed_at IS NULL
            AND created_at > now() - interval '10 minutes'
          RETURNING company_id, account_id, account_domain, redirect_uri`,
        [input.companyId ?? null, input.state],
      );
      const row = consumed.rows[0];
      if (!row) throw new OAuthError('invalid_oauth_state');
      if (row.account_domain !== domain) throw new OAuthError('unexpected_account_domain');
      if (row.redirect_uri !== deps.config.redirectUri) throw new OAuthError('unexpected_redirect_uri');

      const tokens = await postToken({
        client_id: deps.config.clientId,
        client_secret: deps.config.clientSecret,
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: deps.config.redirectUri,
      });
      await withTransaction(deps.db, async (tx) => {
        await writeAccountCredentials(tx, deps.schema, {
          companyId: row.company_id,
          accountId: row.account_id,
          envelope: envelopeOf(deps.cipher, tokens, now()),
          state: 'active',
        });
        await recordOauthAudit(tx, deps.schema, {
          companyId: row.company_id,
          accountId: row.account_id,
          event: 'authorized',
        });
      });
      return { accountId: row.account_id, tokens };
    },

    async refresh(input) {
      const key = `${input.companyId}:${input.accountId}`;
      const startedAt = now();
      const outcome = await withAccountLock(key, async () => {
        // Phase 1: read the account without holding anything. The in-process lock
        // above serializes this process; other processes are handled by the
        // optimistic version check in phase 3, so no row lock spans the network.
        const account = await loadAccount(deps.db, deps.schema, input.companyId, input.accountId);
        if (!account) throw new OAuthError('account_not_found');
        if (account.state === 'revoked') return { kind: 'already_revoked' as const };
        if (!account.credential_ref) throw new OAuthError('credentials_missing');
        const current = decodeEnvelope(deps.cipher, account.credential_ref);
        const fresh = current.expiresAt - now() > REFRESH_SKEW_MS;
        const rotatedDuringWait = current.refreshedAt >= startedAt && current.refreshedAt > 0;
        if ((!input.force && fresh) || (input.force && rotatedDuringWait)) {
          return { kind: 'tokens' as const, tokens: current };
        }

        // Phase 2: the exchange itself, with a deadline and no transaction open.
        let tokens: StoredCredentials;
        try {
          tokens = await postToken({
            client_id: deps.config.clientId,
            client_secret: deps.config.clientSecret,
            grant_type: 'refresh_token',
            refresh_token: current.refreshToken,
            redirect_uri: deps.config.redirectUri,
          });
        } catch (error) {
          if (error instanceof RateLimitError) {
            await withTransaction(deps.db, (tx) =>
              recordOauthAudit(tx, deps.schema, {
                companyId: input.companyId,
                accountId: input.accountId,
                event: 'refresh_rate_limited',
              }),
            );
            return { kind: 'rate_limited' as const, error };
          }
          if (error instanceof AuthRevokedError) {
            await withTransaction(deps.db, async (tx) => {
              await setAccountState(tx, deps.schema, input.companyId, input.accountId, 'revoked');
              await recordOauthAudit(tx, deps.schema, {
                companyId: input.companyId,
                accountId: input.accountId,
                event: 'revoked',
                detail: 'refresh_rejected',
              });
              const channels = await listChannelsByAccount(tx, deps.schema, input);
              for (const channel of channels) {
                await disableChannelAndAlert(tx, { schema: deps.schema ?? 'public' }, {
                  companyId: input.companyId, connectionId: channel.connection_id,
                  dedupeKey: `access_revoked:${input.accountId}:${channel.scope_id}:${account.version}`,
                  errorCode: 'ACCESS_REVOKED',
                });
              }
            });
            // Access was revoked: the channel must stop receiving and sending,
            // and the administrator who owns it must hear about it. The
            // transition is per channel, so each connection is disabled on its
            // own and each one gets its own alert.
            return { kind: 'revoked' as const };
          }
          // The token exchange failed for a reason that is not a revocation:
          // the refresh is exhausted. The channel keeps working with the token
          // it still has, so it is not disabled — but the administrator has to
          // renew the credentials before the channel stops entirely.
          const failure = await deps.db.query<{ refresh_failure_count: number }>(
            `UPDATE ${qualified(deps.schema, 'crm_accounts')}
                SET refresh_failure_count=refresh_failure_count+1
              WHERE company_id=$1 AND id=$2 AND version=$3
              RETURNING refresh_failure_count`,
            [input.companyId,input.accountId,account.version],
          );
          if ((failure.rows[0]?.refresh_failure_count ?? 0) >= 3) await alertAccountChannels(
            { companyId: input.companyId, accountId: input.accountId },
            'refresh_exhausted',
            'TOKEN_REFRESH_FAILED',
            `refresh_failed:${account.version}`,
          );
          throw error;
        }

        // Phase 3: publish only if nobody else rotated the pair in the meantime.
        const published = await withTransaction(deps.db, async (tx) => {
          const updated = await tx.query(
            `UPDATE ${qualified(deps.schema, 'crm_accounts')}
                SET credential_ref=$3, state='active', version=version+1
              WHERE company_id=$1 AND id=$2 AND version=$4 AND state <> 'revoked'`,
            [
              input.companyId,
              input.accountId,
              envelopeOf(deps.cipher, tokens, now()),
              account.version,
            ],
          );
          if ((updated.rowCount ?? 0) === 0) return false;
          await recordOauthAudit(tx, deps.schema, {
            companyId: input.companyId,
            accountId: input.accountId,
            event: 'refreshed',
          });
          return true;
        });
        if (!published) {
          // Another process won the rotation; its pair is the one to use.
          const latest = await loadAccount(deps.db, deps.schema, input.companyId, input.accountId);
          if (latest?.state === 'revoked') return { kind: 'revoked' as const };
          return {
            kind: 'tokens' as const,
            tokens: latest?.credential_ref ? decodeEnvelope(deps.cipher, latest.credential_ref) : tokens,
          };
        }
        return { kind: 'tokens' as const, tokens };
      });
      if (outcome.kind === 'revoked' || outcome.kind === 'already_revoked') {
        if (outcome.kind === 'revoked') {
          notify('amocrm.auth_revoked', { companyId: input.companyId, accountId: input.accountId });
        }
        throw new AuthRevokedError();
      }
      if (outcome.kind === 'rate_limited') throw outcome.error;
      return outcome.tokens;
    },

    async accessToken(input) {
      const refreshed = await this.refresh({ companyId: input.companyId, accountId: input.accountId });
      return refreshed.accessToken;
    },

    async revoke(input) {
      await withTransaction(deps.db, async (tx) => {
        await setAccountState(tx, deps.schema, input.companyId, input.accountId, 'revoked');
        await recordOauthAudit(tx, deps.schema, {
          companyId: input.companyId,
          accountId: input.accountId,
          event: 'revoked',
          detail: input.reason,
        });
      });
      notify('amocrm.auth_revoked', { companyId: input.companyId, accountId: input.accountId });
    },
  };
}

export const OAUTH_STATE_TTL_MS = STATE_TTL_MS;
