import type { FastifyInstance } from 'fastify';
import { roleAtLeast } from '../../platform/auth.ts';
import { logEvent } from '../../platform/logger.ts';
import { sendError } from '../../platform/errors.ts';
import type { OAuthService } from './oauth.ts';

export type OAuthRoutesDeps = {
  oauth: OAuthService;
  /** One-time setup token that allows starting the flow before any staff account exists. */
  setupToken: string | null;
  /** Company the integration belongs to. */
  companyId: string;
  logSink?: (line: string) => void;
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/**
 * Origin of the operator console, derived from the registered redirect_uri.
 * The callback page is served by the API, so `window.location.origin` is not a
 * reliable target for postMessage; the console address comes from configuration.
 */
function consoleOrigin(oauth: OAuthService): string | null {
  if (!oauth.redirectUri) return null;
  try {
    return new URL(oauth.redirectUri).origin;
  } catch {
    return null;
  }
}

/** JSON that is safe to embed inside a <script> element. */
function scriptLiteral(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

/**
 * Result page for the OAuth popup.
 *
 * When the page runs inside the popup opened by the console, it posts the
 * outcome to the opener and closes itself; the console keeps its state and
 * refreshes the connection data. Opened directly, the same page is readable on
 * its own and offers a link back to the console.
 */
function page(
  title: string,
  message: string,
  status: 'ok' | 'error',
  origin: string | null,
): string {
  const payload = scriptLiteral({ type: 'amocrm-oauth', status, message });
  const targetOrigin = origin === null ? 'null' : scriptLiteral(origin);
  const backHref = escapeHtml(origin ?? '/');
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;line-height:1.5}</style>
</head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>
<p><a href="${backHref}">Вернуться в консоль</a></p>
<script>
(function () {
  var payload = ${payload};
  var targetOrigin = ${targetOrigin};
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(payload, targetOrigin || window.location.origin);
      window.close();
    }
  } catch (error) {
    /* Окно-родитель недоступно: остаёмся на странице с результатом. */
  }
})();
</script>
</body></html>`;
}

export function registerAmocrmOAuthRoutes(app: FastifyInstance, deps: OAuthRoutesDeps): void {
  const emit = deps.logSink ?? ((line: string) => process.stdout.write(line + '\n'));

  function setupAllowed(token: unknown): boolean {
    if (typeof token !== 'string' || token.length === 0) return false;
    if (!deps.setupToken || deps.setupToken.length === 0) return false;
    if (token.length !== deps.setupToken.length) return false;
    let diff = 0;
    for (let i = 0; i < token.length; i += 1) diff |= token.charCodeAt(i) ^ deps.setupToken.charCodeAt(i);
    return diff === 0;
  }

  app.get('/api/v2/integrations/amocrm/oauth/authorize', async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const session = request.session;
    const adminSession = session !== null && roleAtLeast(session.role, 'admin');
    const tokenAllowed = setupAllowed(query.setup);

    if (!adminSession && !tokenAllowed) {
      return sendError(reply, request.correlationId, 'UNAUTHENTICATED', 401);
    }

    const companyId = adminSession && session ? session.companyId : deps.companyId;
    try {
      const { url } = await deps.oauth.authorizationUrl({ companyId, accountId: deps.companyId });
      logEvent('info', 'amocrm.oauth.authorize', { correlationId: request.correlationId, companyId }, emit);
      return reply.redirect(url);
    } catch {
      return sendError(reply, request.correlationId, 'UPSTREAM_UNAVAILABLE', 502);
    }
  });

  app.get('/api/v2/integrations/amocrm/oauth/callback', async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const code = typeof query.code === 'string' ? query.code : '';
    const state = typeof query.state === 'string' ? query.state : '';

    reply.type('text/html; charset=utf-8');
    const origin = consoleOrigin(deps.oauth);

    if (!code || !state) {
      reply.code(400);
      return page(
        'Авторизация не завершена',
        'amoCRM не передал код авторизации. Начните подключение заново.',
        'error',
        origin,
      );
    }

    try {
      // No company is asserted here: the callback arrives from amoCRM without a
      // console session, and the state row already records the tenant that
      // started the flow. Passing the configured company would tie completion
      // to a tenant that may not be the one that authorized.
      const result = await deps.oauth.complete({ code, state });
      logEvent('info', 'amocrm.oauth.completed', { correlationId: request.correlationId, accountId: result.accountId }, emit);
      return page(
        'Интеграция подключена',
        'Токены получены и сохранены в зашифрованном виде. Можно переходить к регистрации канала.',
        'ok',
        origin,
      );
    } catch (error) {
      const reason = (error as { message?: string }).message ?? 'oauth_failed';
      logEvent('warn', 'amocrm.oauth.failed', { correlationId: request.correlationId, reason }, emit);
      reply.code(400);
      // The reason stays in the server log; the popup only gets a safe summary.
      return page(
        'Не удалось подключить',
        'Код авторизации отклонён или истёк. Начните подключение заново.',
        'error',
        origin,
      );
    }
  });

  app.post('/api/v2/integrations/amocrm/oauth/revoke', async (request, reply) => {
    const session = request.session;
    if (!session || !roleAtLeast(session.role, 'admin')) {
      return sendError(reply, request.correlationId, 'FORBIDDEN', 403);
    }
    try {
      await deps.oauth.revoke({ companyId: session.companyId, accountId: session.companyId, reason: 'operator_request' });
      logEvent('info', 'amocrm.oauth.revoked', { correlationId: request.correlationId }, emit);
      return { status: 'revoked' };
    } catch {
      return sendError(reply, request.correlationId, 'UPSTREAM_UNAVAILABLE', 502);
    }
  });
}
