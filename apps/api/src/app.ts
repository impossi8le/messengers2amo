import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Config } from './platform/config.ts';
import type { Db } from './platform/db.ts';
import { decodeSession, roleAtLeast, type Role, type Session } from './platform/auth.ts';
import type { LoginLimiterOptions } from './platform/login-limiter.ts';
import { correlationId, logEvent } from './platform/logger.ts';
import { sendError } from './platform/errors.ts';
import { collectMetrics, renderPrometheus } from './observability/metrics.ts';
import { loadSession } from './auth/service.ts';
import { registerAuthRoutes } from './auth/routes.ts';
import { registerConnectionRoutes } from './connections/routes.ts';
import { registerConnectionSetupRoutes } from './connections/setup-routes.ts';
import { registerOperatorRoutes } from './operator/routes.ts';
import { registerInternalRoutes } from './internal/routes.ts';
import { registerTelegramWebhook } from './telegram/webhook.ts';
import { registerChannelWebhooks } from './channels/webhooks.ts';
import {registerChannelCatalogRoutes} from './channels/catalog-routes.ts';
import { MediaService, type MediaServiceDeps } from './media/service.ts';
import { registerMediaRoutes } from './media/routes.ts';
import { registerCrmMediaRoutes } from './media/crm-access.ts';
import {registerCrmDriveMediaRoutes} from './media/crm-drive-access.ts';
import {registerCrmAvatarRoutes} from './media/crm-avatar-access.ts';
import {decryptTelegramCredentials} from './connections/telegram-setup.ts';
import type {AmoDriveReader} from './integrations/amocrm/drive-reader.ts';
import { defaultLimits } from './media/policy.ts';
import type { ObjectStorage } from './media/storage.ts';
import { registerAmocrmWebhook } from './integrations/amocrm/webhook.ts';
import type { TokenCipher } from './integrations/amocrm/crypto.ts';
import type { OAuthService } from './integrations/amocrm/oauth.ts';
import { registerAmocrmOAuthRoutes } from './integrations/amocrm/oauth-routes.ts';
import type { WorkflowClient } from './integrations/amocrm/workflow.ts';
import type { PipelineCatalogue } from './integrations/amocrm/pipelines.ts';
import {
  registerAmocrmWorkflowRoutes,
  unavailableWorkflowClient,
} from './integrations/amocrm/workflow-routes.ts';
import { registerWorkshopRoutes } from './workshops/routes.ts';
import { registerCrmDirectoryRoutes } from './integrations/amocrm/directory-routes.ts';
import type { CrmDirectoryClient } from './integrations/amocrm/directory-client.ts';

export type MediaAppDeps = Partial<
  Pick<MediaServiceDeps, 'limits' | 'remoteFetch' | 'archiveContractRef' | 'uploadTtlSeconds' | 'grantTtlSeconds'>
> & {
  schema: string;
  storage: ObjectStorage;
};

export type AmocrmAppDeps = {
  cipher: TokenCipher;
  schema?: string;
  /** Reserved for connect/sync flows; webhook verification is local. */
  fetch?: typeof fetch;
  /** Enables the OAuth authorize/callback/revoke routes when provided. */
  oauth?: OAuthService;
  setupToken?: string | null;
  companyId?: string;
  /** CRM adapter used by the assignment-workflow routes; read-only routes work without it. */
  workflowClient?: WorkflowClient;
  /** Funnels and stages of the account, for the admin routing screen. */
  pipelines?: PipelineCatalogue;
  directoryClient?: CrmDirectoryClient;
  /** amoCRM account domain, used to link the operator to the bound card. */
  accountDomain?: string | null;
  driveReader?:AmoDriveReader;
};

export type AppDeps = {
  config: Config;
  db: Db;
  now?: () => number;
  media?: MediaAppDeps;
  amocrm?: AmocrmAppDeps;
  /** Schema holding the operator tables; unqualified queries rely on search_path. */
  operator?: { schema?: string };
  /** Test/observability hook; production defaults to stdout. */
  logSink?: (line: string) => void;
  /** Login throttling knobs; production defaults apply when omitted. */
  auth?: { login?: LoginLimiterOptions };
  /** Bearer token protecting /metrics; when absent the route is not registered. */
  metricsToken?: string | null;
  /** Schema holding queue and inbox tables for metrics. */
  metricsSchema?: string;
};

declare module 'fastify' {
  interface FastifyRequest {
    session: Session | null;
    correlationId: string;
  }
}

const SESSION_COOKIE = 'staff_session';

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return null;
}

export function requireRole(request: FastifyRequest, reply: FastifyReply, role: Role): Session | null {
  const session = request.session;
  if (!session) {
    sendError(reply, request.correlationId, 'UNAUTHENTICATED');
    return null;
  }
  if (!roleAtLeast(session.role, role)) {
    sendError(reply, request.correlationId, 'FORBIDDEN');
    return null;
  }
  return session;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    trustProxy: deps.config.trustedProxy,
    bodyLimit: 1024 * 1024,
    disableRequestLogging: true,
  });

  app.decorateRequest('session', null);
  app.decorateRequest('correlationId', '');

  const emitLog = deps.logSink ?? ((line: string) => process.stdout.write(line + '\n'));

  app.addHook('onRequest', async (request, reply) => {
    request.correlationId = correlationId(request.headers['x-correlation-id']);
    reply.header('x-correlation-id', request.correlationId);
    // The cookie is only a lookup key: the session row, its revocation flag, expiry and
    // the current authorization version are re-checked on every request. An actor id
    // supplied by a native amoCRM header is never used as identity.
    const token = readCookie(request.headers.cookie, SESSION_COOKIE);
    const decoded = token ? decodeSession(deps.config.sessionSecret, token, deps.now?.() ?? Date.now()) : null;
    request.session = decoded ? await loadSession(deps.db, decoded, deps.now?.() ?? Date.now()) : null;
  });

  app.addHook('onResponse', async (request, reply) => {
    logEvent(
      'info',
      'http.request',
      {
        correlationId: request.correlationId,
        method: request.method,
        route: request.routeOptions.url ?? request.url.split('?')[0],
        status: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
        companyId: request.session?.companyId ?? null,
        staffId: request.session?.staffId ?? null,
      },
      emitLog,
    );
  });

  if (deps.media) {
    const limits = defaultLimits(deps.media.limits);
    const service = new MediaService({
      db: deps.db,
      schema: deps.media.schema,
      storage: deps.media.storage,
      sessionSecret: deps.config.sessionSecret,
      now: deps.now,
      limits,
      remoteFetch: deps.media.remoteFetch ?? null,
      archiveContractRef: deps.media.archiveContractRef ?? null,
      uploadTtlSeconds: deps.media.uploadTtlSeconds,
      grantTtlSeconds: deps.media.grantTtlSeconds,
    });
    registerMediaRoutes(app, service, limits.maxFileBytes, limits.maxConcurrentUploads);
    registerCrmMediaRoutes(app, {db:deps.db,schema:deps.media.schema,storage:deps.media.storage,secret:deps.config.sessionSecret});
  }

  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_request, reply) => {
    try {
      await deps.db.query('SELECT 1');
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'unavailable', dependency: 'database' });
    }
  });

  if (deps.metricsToken && deps.metricsToken.length > 0) {
    const expected = deps.metricsToken;
    app.get('/metrics', async (request, reply) => {
      const header = request.headers.authorization;
      const presented = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
      // Constant-time comparison over equal-length buffers only.
      let allowed = presented.length === expected.length && presented.length > 0;
      if (allowed) {
        let diff = 0;
        for (let i = 0; i < expected.length; i += 1) diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
        allowed = diff === 0;
      }
      if (!allowed) return sendError(reply, request.correlationId, 'UNAUTHENTICATED', 401);
      try {
        const samples = await collectMetrics(deps.db, deps.metricsSchema ?? 'public');
        reply.type('text/plain; version=0.0.4; charset=utf-8');
        return renderPrometheus(samples);
      } catch {
        return sendError(reply, request.correlationId, 'UPSTREAM_UNAVAILABLE', 503);
      }
    });
  }

  registerTelegramWebhook(app, deps);
  registerChannelWebhooks(app, deps);
  if(deps.amocrm)registerCrmAvatarRoutes(app,{db:deps.db,schema:deps.amocrm.schema??'public',secret:deps.config.sessionSecret,
    fetch:deps.amocrm.fetch,
    resolveBotToken:(connection)=>{
      if(connection.credentialRef?.startsWith('chancred_v1.')){
        try{return decryptTelegramCredentials(deps.amocrm!.cipher,connection.credentialRef,connection).botToken;}catch{return null;}
      }
      return deps.config.telegram?.botToken??null;
    }});
  if(deps.amocrm?.driveReader)registerCrmDriveMediaRoutes(app,{db:deps.db,schema:deps.amocrm.schema??'public',reader:deps.amocrm.driveReader,secret:deps.config.sessionSecret});
  if (deps.amocrm) registerAmocrmWebhook(app, { db: deps.db, schema: deps.amocrm.schema, cipher: deps.amocrm.cipher });
  if (deps.amocrm?.oauth) {
    registerAmocrmOAuthRoutes(app, {
      oauth: deps.amocrm.oauth,
      setupToken: deps.amocrm.setupToken ?? null,
      companyId: deps.amocrm.companyId ?? 'default',
      logSink: emitLog,
    });
  }
  registerAuthRoutes(app, { ...deps, loginLimiter: deps.auth?.login });
  const operatorSchema = deps.operator?.schema ?? 'public';
  registerConnectionRoutes(app, { ...deps, schema: operatorSchema });
  registerChannelCatalogRoutes(app);
  registerConnectionSetupRoutes(app, deps);
  registerOperatorRoutes(app, {
    db: deps.db,
    schema: operatorSchema,
    pipelines: deps.amocrm?.pipelines,
    oauthEnabled: Boolean(deps.amocrm?.oauth),
  });
  registerCrmDirectoryRoutes(app,{db:deps.db,schema:operatorSchema,client:deps.amocrm?.directoryClient});
  // The internal CRM adapter group exists only when its identity is configured.
  // An empty token means "no adapter in this deployment", not "open access".
  const internalServiceToken = deps.config.internalServiceToken ?? null;
  if (internalServiceToken) {
    registerInternalRoutes(app, {
      db: deps.db,
      schema: operatorSchema,
      token: internalServiceToken,
      companyId: deps.config.amocrm?.companyId ?? null,
    });
  }
  registerWorkshopRoutes(app, { db: deps.db, schema: operatorSchema });
  registerAmocrmWorkflowRoutes(app, {
    db: deps.db,
    schema: deps.amocrm?.schema ?? operatorSchema,
    client: deps.amocrm?.workflowClient ?? unavailableWorkflowClient,
    now: deps.now,
    accountDomain: deps.amocrm?.accountDomain ?? null,
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    const failure = error as { code?: unknown; statusCode?: unknown };
    const statusCode = typeof failure.statusCode === 'number' ? failure.statusCode : 500;
    logEvent(
      'error',
      'http.error',
      {
        correlationId: request.correlationId,
        route: request.routeOptions.url ?? request.url.split('?')[0],
        code: typeof failure.code === 'string' ? failure.code : 'internal_error',
        status: statusCode,
      },
      emitLog,
    );
    if (statusCode < 500) {
      return sendError(reply, request.correlationId, 'VALIDATION_FAILED', statusCode);
    }
    return sendError(reply, request.correlationId, 'INTERNAL_ERROR');
  });

  return app;
}

export { SESSION_COOKIE };
