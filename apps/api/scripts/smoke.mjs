#!/usr/bin/env node
/**
 * Сквозной smoke-прогон: одна команда, которая за минуту показывает, что инстанс
 * живой и работает по всему пути — health, аутентификация, защита операторских
 * маршрутов, приём вебхука, внутренний CRM-контур и метрики.
 *
 *   node scripts/smoke.mjs --local
 *   node scripts/smoke.mjs --url https://api.example.test [--email ... --password ...]
 *
 * Локальный режим поднимает приложение в этом же процессе на loopback-порту,
 * создаёт одноразовую схему в TEST_DATABASE_URL, наполняет её минимумом и удаляет
 * схему в finally — даже если проверка упала.
 *
 * Удалённый режим говорит только по HTTP с явно переданным адресом и никогда не
 * обращается к базе инстанса.
 *
 * Секреты (пароль, токены, webhook-секрет) берутся из аргументов или окружения,
 * а в локальном режиме генерируются в процессе. В вывод они не попадают: все
 * сообщения проходят через redact().
 */

import { randomBytes } from 'node:crypto';

const USAGE = `Smoke-прогон API.

  node scripts/smoke.mjs --local
      Поднять приложение в процессе на временной схеме TEST_DATABASE_URL,
      прогнать весь путь и удалить схему.

  node scripts/smoke.mjs --url <base>
      Проверить уже развёрнутый инстанс только по HTTP.
      Дополнительно: --email <staffId> --password <password> [--company-id <id>]
      для входа и чтения операторских списков;
      --webhook-secret <secret> чтобы проверить 404 на несуществующем подключении;
      --metrics-token <token> и --internal-token <token> для проверок с токеном.

  Общие флаги: --timeout <ms>, --help.
  Те же значения читаются из окружения: SMOKE_URL, SMOKE_EMAIL, SMOKE_PASSWORD,
  SMOKE_COMPANY_ID, SMOKE_WEBHOOK_SECRET, SMOKE_METRICS_TOKEN,
  SMOKE_INTERNAL_TOKEN, SMOKE_TIMEOUT_MS.

Коды выхода: 0 — все проверки прошли, 1 — есть FAIL или прогон не смог стартовать,
2 — неверные аргументы.`;

const DEFAULT_TIMEOUT_MS = 10_000;
const SESSION_COOKIE = 'staff_session';

// Every generated or supplied secret is registered here so redact() can strip it
// from any message, including unexpected errors raised by the runtime.
const secretValues = new Set();

function rememberSecret(value) {
  if (typeof value === 'string' && value.length > 0) secretValues.add(value);
  return value;
}

function redact(value) {
  let text = String(value);
  for (const secret of secretValues) {
    if (secret.length >= 4) text = text.split(secret).join('<redacted>');
  }
  // Connection strings and bearer values can appear in driver errors.
  text = text.replace(/postgres(?:ql)?:\/\/[^\s"'`]+/gi, 'postgres://<redacted>');
  text = text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>');
  return text;
}

// --- arguments ---------------------------------------------------------------

function parseArgs(argv) {
  const options = {
    mode: 'local',
    url: process.env.SMOKE_URL ?? null,
    email: process.env.SMOKE_EMAIL ?? null,
    password: process.env.SMOKE_PASSWORD ?? null,
    companyId: process.env.SMOKE_COMPANY_ID ?? 'default',
    webhookSecret: process.env.SMOKE_WEBHOOK_SECRET ?? null,
    metricsToken: process.env.SMOKE_METRICS_TOKEN ?? null,
    internalToken: process.env.SMOKE_INTERNAL_TOKEN ?? null,
    timeoutMs: Number.parseInt(process.env.SMOKE_TIMEOUT_MS ?? '', 10) || DEFAULT_TIMEOUT_MS,
    help: false,
  };
  if (options.url) options.mode = 'remote';
  rememberSecret(options.password);
  rememberSecret(options.webhookSecret);
  rememberSecret(options.metricsToken);
  rememberSecret(options.internalToken);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`missing value for ${arg}`);
      index += 1;
      return next;
    };
    switch (arg) {
      case '--local':
        options.mode = 'local';
        options.url = null;
        break;
      case '--url': {
        const url = value();
        let parsed;
        try {
          parsed = new URL(url);
        } catch {
          throw new Error(`--url must be an absolute http(s) URL, got ${JSON.stringify(url)}`);
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new Error(`--url must use http or https, got ${parsed.protocol}`);
        }
        options.mode = 'remote';
        options.url = url;
        break;
      }
      case '--email':
        options.email = value();
        break;
      case '--password':
        options.password = rememberSecret(value());
        break;
      case '--company-id':
        options.companyId = value();
        break;
      case '--webhook-secret':
        options.webhookSecret = rememberSecret(value());
        break;
      case '--metrics-token':
        options.metricsToken = rememberSecret(value());
        break;
      case '--internal-token':
        options.internalToken = rememberSecret(value());
        break;
      case '--timeout': {
        const parsed = Number.parseInt(value(), 10);
        if (!Number.isFinite(parsed) || parsed <= 0) throw new Error('--timeout must be a positive number of milliseconds');
        options.timeoutMs = parsed;
        break;
      }
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (options.mode === 'remote' && !options.url) throw new Error('--url <base> is required for remote mode');
  return options;
}

// --- reporting ---------------------------------------------------------------

const results = [];

function report(status, name, detail) {
  const suffix = detail ? `  ${redact(detail)}` : '';
  console.log(`${status.padEnd(4)}  ${name}${suffix}`);
  results.push({ status, name });
}

function pass(name, detail) {
  report('PASS', name, detail);
}

function fail(name, detail) {
  report('FAIL', name, detail);
}

function skip(name, reason) {
  report('SKIP', name, reason);
}

/** Keeps the useful part of a failure: the message plus fetch's underlying code. */
function describeError(error) {
  if (error === null || typeof error !== 'object') return String(error);
  const name = typeof error.name === 'string' ? error.name : '';
  const message = typeof error.message === 'string' ? error.message : String(error);
  if (name === 'TimeoutError') return 'request timed out';
  const cause = error.cause;
  if (cause && typeof cause === 'object' && typeof cause.code === 'string') {
    return `${message} (${cause.code})`;
  }
  return message;
}

async function check(name, fn) {
  try {
    const detail = await fn();
    pass(name, detail === undefined || detail === null ? '' : String(detail));
  } catch (error) {
    fail(name, describeError(error));
  }
}

function summarize(label) {
  const passed = results.filter((item) => item.status === 'PASS').length;
  const failed = results.filter((item) => item.status === 'FAIL').length;
  const skipped = results.filter((item) => item.status === 'SKIP').length;
  const parts = [`${passed} passed`, `${failed} failed`];
  if (skipped > 0) parts.push(`${skipped} skipped`);
  console.log('');
  console.log(`${label}: ${parts.join(', ')}`);
  if (failed > 0) process.exitCode = 1;
}

// --- HTTP client -------------------------------------------------------------

function createHttp(baseUrl, timeoutMs) {
  const base = new URL(baseUrl);
  return async function request(method, path, { headers = {}, body } = {}) {
    const init = {
      method,
      headers: { accept: 'application/json, text/plain;q=0.9, */*;q=0.1', ...headers },
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const response = await fetch(new URL(path, base), init);
    const text = await response.text();
    let json = null;
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { status: response.status, headers: response.headers, text, json };
  };
}

function statusIs(response, expected, label) {
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (!allowed.includes(response.status)) {
    throw new Error(`${label}: HTTP ${response.status}, expected ${allowed.join(' or ')}`);
  }
  return `HTTP ${response.status}`;
}

function sessionCookieFrom(response) {
  const raw = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  for (const value of raw) {
    const first = String(value).split(';')[0] ?? '';
    if (first.startsWith(`${SESSION_COOKIE}=`)) return first;
  }
  return null;
}

// --- shared check groups -----------------------------------------------------

async function checkHealth(request) {
  await check('health live', async () => statusIs(await request('GET', '/health/live'), 200, 'health live'));
  await check('health ready', async () => statusIs(await request('GET', '/health/ready'), 200, 'health ready'));
}

async function checkOperatorReads(request, cookie, paths) {
  for (const [name, path] of paths) {
    await check(`operator: ${name}`, async () =>
      statusIs(await request('GET', path, { headers: { cookie } }), 200, name),
    );
  }
}

// --- local mode --------------------------------------------------------------

async function runLocal(options) {
  const [{ createTestDb }, { testConfig }, { buildApp }, seed, telegram, processor] = await Promise.all([
    import('../test/helpers/db.ts'),
    import('../test/helpers/app.ts'),
    import('../src/app.ts'),
    import('../test/helpers/seed.ts'),
    import('../test/helpers/telegram.ts'),
    import('../src/telegram/processor.ts'),
  ]);

  const password = rememberSecret(`smoke-${randomBytes(12).toString('hex')}`);
  const webhookSecret = rememberSecret(`smoke-wh-${randomBytes(12).toString('hex')}`);
  // The deliberately wrong variants are derived from the real values; keep them out
  // of any error text too.
  rememberSecret(`${password}-wrong`);
  rememberSecret(`${webhookSecret}-wrong`);
  const metricsToken = rememberSecret(`smoke-metrics-${randomBytes(12).toString('hex')}`);
  const internalToken = rememberSecret(`smoke-internal-${randomBytes(12).toString('hex')}`);

  const companyId = 'smoke_company';
  const staffId = 'smoke_staff';
  const workshopId = 'smoke_workshop';
  const connectionId = 'smoke_connection';

  let testDb = null;
  let app = null;
  let bareApp = null;
  try {
    testDb = await createTestDb();
    const { db, schema } = testDb;

    // buildApp directly (the harness does the same) so request logs go to a sink
    // instead of stdout and the smoke output stays one line per check.
    const startApp = async (internalServiceToken) => {
      const instance = await buildApp({
        config: testConfig({
          telegram: { botToken: 'smoke-bot-token', webhookSecret, apiBase: 'https://telegram.invalid' },
          internalServiceToken,
        }),
        db,
        operator: { schema },
        metricsToken,
        metricsSchema: schema,
        logSink: () => {},
      });
      await instance.listen({ port: 0, host: '127.0.0.1' });
      const address = instance.server.address();
      const port = typeof address === 'object' && address !== null ? address.port : null;
      if (!port) throw new Error('the local app did not expose a listening port');
      return { instance, request: createHttp(`http://127.0.0.1:${port}`, options.timeoutMs) };
    };

    const started = await startApp(internalToken);
    app = started.instance;
    const request = started.request;

    // A deployment without INTERNAL_SERVICE_TOKEN must not register the adapter group
    // at all. That state is exclusive with the configured one, so it gets its own
    // short-lived instance on the same schema.
    bareApp = await startApp(null);

    // Minimum tenant: company, workshop, one staff member with a password, and an
    // active Telegram connection routed to that workshop.
    await seed.seedCompany(db, {
      companyId,
      workshops: [workshopId],
      staff: [{ id: staffId, password, role: 'send', workshopId }],
    });
    await db.query('UPDATE staff SET capacity = $2, availability = $3 WHERE company_id = $1', [
      companyId,
      5,
      'online',
    ]);
    await seed.seedConnection(db, {
      companyId,
      id: connectionId,
      state: 'active',
      workshopId,
      ownerId: staffId,
    });

    const countInbox = async () => {
      const { rows } = await db.query(
        `SELECT count(*)::int AS c FROM "${schema}".inbox_events WHERE company_id = $1 AND connection_id = $2`,
        [companyId, connectionId],
      );
      return rows[0].c;
    };

    await checkHealth(request);

    await check('login: wrong password rejected', async () => {
      const response = await request('POST', '/api/v2/auth/login', {
        body: { companyId, staffId, password: `${password}-wrong` },
      });
      return statusIs(response, 401, 'login');
    });

    let cookie = null;
    await check('login: valid credentials', async () => {
      const response = await request('POST', '/api/v2/auth/login', {
        body: { companyId, staffId, password },
      });
      statusIs(response, 200, 'login');
      cookie = sessionCookieFrom(response);
      if (!cookie) throw new Error('login: HTTP 200 without a staff_session cookie');
      return 'HTTP 200, session cookie set';
    });

    await check('operator: anonymous request rejected', async () =>
      statusIs(await request('GET', '/api/v2/operator/work-items'), 401, 'work-items'),
    );

    if (cookie) {
      await check('operator: work-items list', async () =>
        statusIs(await request('GET', '/api/v2/operator/work-items', { headers: { cookie } }), 200, 'work-items'),
      );
      await check('operator: foreign companyId rejected', async () => {
        const response = await request('GET', '/api/v2/operator/work-items?companyId=smoke_foreign', {
          headers: { cookie },
        });
        if (response.status === 200) {
          throw new Error('work-items: HTTP 200 — the tenant selector in the query is not rejected');
        }
        return `${statusIs(response, [400, 403], 'work-items')} (rejected)`;
      });
      await checkOperatorReads(request, cookie, [
        ['connections', '/api/v2/operator/connections'],
        ['workshops', '/api/v2/operator/workshops'],
        ['staff availability', '/api/v2/operator/staff/availability'],
        ['notifications', '/api/v2/operator/notifications'],
      ]);
    } else {
      for (const name of [
        'work-items list',
        'foreign companyId rejected',
        'connections',
        'workshops',
        'staff availability',
        'notifications',
      ]) {
        skip(`operator: ${name}`, 'no session cookie');
      }
    }

    // Webhook: one accepted delivery, one duplicate, one rejected secret.
    const update = telegram.telegramMessageUpdate(9001, 501, 'Smoke check: inbound message');
    const inboxBefore = await countInbox();

    await check('telegram webhook: valid secret stores one event', async () => {
      const response = await request('POST', `/webhooks/telegram/${connectionId}`, {
        headers: { 'x-telegram-bot-api-secret-token': webhookSecret },
        body: update,
      });
      statusIs(response, 200, 'webhook');
      const after = await countInbox();
      if (after !== inboxBefore + 1) throw new Error(`inbox rows: ${inboxBefore} -> ${after}, expected +1`);
      return 'HTTP 200, +1 inbox event';
    });

    await check('telegram webhook: duplicate delivery is deduplicated', async () => {
      const response = await request('POST', `/webhooks/telegram/${connectionId}`, {
        headers: { 'x-telegram-bot-api-secret-token': webhookSecret },
        body: update,
      });
      statusIs(response, 200, 'webhook');
      if (response.json?.duplicate !== true) {
        throw new Error(`webhook: duplicate flag is ${JSON.stringify(response.json?.duplicate)}, expected true`);
      }
      const after = await countInbox();
      if (after !== inboxBefore + 1) throw new Error(`inbox rows changed: ${after}, expected ${inboxBefore + 1}`);
      return 'HTTP 200, duplicate=true, no new row';
    });

    await check('telegram webhook: bad secret rejected', async () => {
      const response = await request('POST', `/webhooks/telegram/${connectionId}`, {
        headers: { 'x-telegram-bot-api-secret-token': `${webhookSecret}-wrong` },
        body: telegram.telegramMessageUpdate(9002, 502, 'Smoke check: must be rejected'),
      });
      statusIs(response, 401, 'webhook');
      const after = await countInbox();
      if (after !== inboxBefore + 1) throw new Error(`inbox rows changed: ${after}, expected ${inboxBefore + 1}`);
      return 'HTTP 401, nothing stored';
    });

    await check('inbox drain: update becomes a work item', async () => {
      if (!cookie) throw new Error('no session cookie');
      const drained = await processor.drainTelegramInbox(db, { schema });
      if (drained.applied !== 1) throw new Error(`applied ${drained.applied} update(s), expected 1`);
      const response = await request('GET', '/api/v2/operator/work-items', { headers: { cookie } });
      statusIs(response, 200, 'work-items');
      const items = Array.isArray(response.json?.items) ? response.json.items : [];
      if (items.length === 0) throw new Error('work-items list is empty after the inbound update');
      return `applied 1, ${items.length} work item(s) visible`;
    });

    await check('internal crm: unconfigured group is not routed', async () =>
      statusIs(await bareApp.request('GET', '/api/v2/internal/crm/bindings'), 404, 'internal'),
    );

    await check('internal crm: service token accepted', async () =>
      statusIs(
        await request('GET', '/api/v2/internal/crm/bindings', {
          headers: { authorization: `Bearer ${internalToken}` },
        }),
        200,
        'internal',
      ),
    );

    await check('metrics: anonymous rejected', async () =>
      statusIs(await request('GET', '/metrics'), [401, 404], 'metrics'),
    );

    await check('metrics: bearer token accepted', async () => {
      const response = await request('GET', '/metrics', {
        headers: { authorization: `Bearer ${metricsToken}` },
      });
      statusIs(response, 200, 'metrics');
      if (!response.text.includes('m2a_')) throw new Error('metrics: body does not look like Prometheus output');
      return 'HTTP 200, Prometheus body';
    });

    return 'local';
  } finally {
    for (const instance of [bareApp?.instance, app]) {
      if (!instance) continue;
      try {
        await instance.close();
      } catch {
        // A close failure must not hide the original check result.
      }
    }
    if (testDb) {
      try {
        await testDb.close();
      } catch {
        // Dropping the schema is best-effort here; the pool is ended either way.
      }
    }
  }
}

// --- remote mode -------------------------------------------------------------

async function runRemote(options) {
  const request = createHttp(options.url, options.timeoutMs);

  await checkHealth(request);

  await check('operator: anonymous request rejected', async () =>
    statusIs(await request('GET', '/api/v2/operator/work-items'), 401, 'work-items'),
  );

  await check('metrics: anonymous rejected', async () =>
    statusIs(await request('GET', '/metrics'), [401, 404], 'metrics'),
  );

  await check('telegram webhook: bad secret rejected', async () => {
    const response = await request('POST', '/webhooks/telegram/smoke-probe', {
      headers: { 'x-telegram-bot-api-secret-token': `smoke-wrong-${randomBytes(8).toString('hex')}` },
      body: { update_id: 1 },
    });
    if (response.status === 503) throw new Error('webhook: HTTP 503 — Telegram is not configured on this instance');
    return statusIs(response, 401, 'webhook');
  });

  if (options.webhookSecret) {
    await check('telegram webhook: unknown connection is 404', async () => {
      const response = await request('POST', `/webhooks/telegram/smoke-missing-${randomBytes(6).toString('hex')}`, {
        headers: { 'x-telegram-bot-api-secret-token': options.webhookSecret },
        body: { update_id: 1 },
      });
      return statusIs(response, 404, 'webhook');
    });
  } else {
    skip('telegram webhook: unknown connection is 404', 'pass --webhook-secret to enable');
  }

  if (options.email && options.password) {
    let cookie = null;
    await check('login: valid credentials', async () => {
      const response = await request('POST', '/api/v2/auth/login', {
        body: { companyId: options.companyId, staffId: options.email, password: options.password },
      });
      statusIs(response, 200, 'login');
      cookie = sessionCookieFrom(response);
      if (!cookie) throw new Error('login: HTTP 200 without a staff_session cookie');
      return 'HTTP 200, session cookie set';
    });

    if (cookie) {
      await checkOperatorReads(request, cookie, [
        ['work-items', '/api/v2/operator/work-items'],
        ['connections', '/api/v2/operator/connections'],
        ['workshops', '/api/v2/operator/workshops'],
      ]);
    } else {
      for (const name of ['work-items', 'connections', 'workshops']) {
        skip(`operator: ${name}`, 'no session cookie');
      }
    }
  } else {
    skip('login: valid credentials', 'pass --email and --password to enable');
    for (const name of ['work-items', 'connections', 'workshops']) {
      skip(`operator: ${name}`, 'pass --email and --password to enable');
    }
  }

  if (options.metricsToken) {
    await check('metrics: bearer token accepted', async () => {
      const response = await request('GET', '/metrics', {
        headers: { authorization: `Bearer ${options.metricsToken}` },
      });
      statusIs(response, 200, 'metrics');
      if (!response.text.includes('m2a_')) throw new Error('metrics: body does not look like Prometheus output');
      return 'HTTP 200, Prometheus body';
    });
  } else {
    skip('metrics: bearer token accepted', 'pass --metrics-token to enable');
  }

  if (options.internalToken) {
    await check('internal crm: service token accepted', async () =>
      statusIs(
        await request('GET', '/api/v2/internal/crm/bindings', {
          headers: { authorization: `Bearer ${options.internalToken}` },
        }),
        200,
        'internal',
      ),
    );
  } else {
    skip('internal crm: service token accepted', 'pass --internal-token to enable');
  }

  return 'remote';
}

// --- entry point -------------------------------------------------------------

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(`smoke: ${redact(describeError(error))}`);
  console.error('');
  console.error(USAGE);
  process.exit(2);
}

if (options.help) {
  console.log(USAGE);
  process.exit(0);
}

// Webhook handlers log through the platform logger directly, bypassing the app log
// sink, so their JSON lines would interleave with the PASS/FAIL report. Drop exactly
// those lines and let everything else through untouched.
function silenceStructuredLogs() {
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, encoding, callback) => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    if (text.startsWith('{"ts":')) {
      if (typeof encoding === 'function') encoding();
      else if (typeof callback === 'function') callback();
      return true;
    }
    return write(chunk, encoding, callback);
  };
}

if (options.mode === 'local') silenceStructuredLogs();

let label = options.mode === 'local' ? 'smoke (local)' : `smoke (${options.url})`;
try {
  label = `smoke (${await (options.mode === 'remote' ? runRemote(options) : runLocal(options))})`;
} catch (error) {
  // Setup failures happen outside the per-check runner (schema, migrations, listen).
  fail('setup', describeError(error));
} finally {
  summarize(label);
}
