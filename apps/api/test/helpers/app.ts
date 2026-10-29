import { buildApp, type AmocrmAppDeps, type MediaAppDeps } from '../../src/app.ts';
import { issueSession, type Role } from '../../src/platform/auth.ts';
import type { LoginLimiterOptions } from '../../src/platform/login-limiter.ts';
import type { Config } from '../../src/platform/config.ts';
import type { Db } from '../../src/platform/db.ts';
import { createTestDb } from './db.ts';
import { sessionIdFor } from './fixtures.ts';

export const TEST_SESSION_SECRET = 'test-session-secret-'.padEnd(48, 'x');

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    host: '127.0.0.1',
    databaseUrl: 'postgres://unused',
    sessionSecret: TEST_SESSION_SECRET,
    sessionTtlSeconds: 3600,
    secureCookies: false,
    trustedProxy: false,
    adminBootstrapToken: null,
    s3: null,
    amocrm: null,
    telegram: null,
    outboundEnabled: false,
    metricsToken: null,
    ...overrides,
  };
}

export function sessionCookie(
  companyId: string,
  staffId: string,
  role: Role = 'send',
  now = Date.now(),
): string {
  const token = issueSession(
    TEST_SESSION_SECRET,
    { sessionId: sessionIdFor(companyId, staffId), staffId, companyId, role, workshopId: null, epoch: 1 },
    3600,
  );
  void now;
  return `staff_session=${token}`;
}

/** Extracts the `staff_session=...` pair from a real login response. */
export function cookieFromResponse(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers['set-cookie'];
  const values = Array.isArray(raw) ? raw.map(String) : [String(raw ?? '')];
  for (const value of values) {
    const first = value.split(';')[0] ?? '';
    if (first.startsWith('staff_session=')) return first;
  }
  throw new Error(`no staff_session cookie in ${JSON.stringify(raw)}`);
}

export async function buildTestApp(options: {
  db: Db;
  schema?: string;
  media?: MediaAppDeps;
  amocrm?: AmocrmAppDeps;
  now?: () => number;
  config?: Partial<Config>;
  metricsToken?: string | null;
}) {
  const app = await buildApp({
    config: testConfig(options.config),
    db: options.db,
    now: options.now,
    media: options.media,
    amocrm: options.amocrm,
    metricsToken: options.metricsToken ?? null,
    metricsSchema: options.schema ?? options.media?.schema ?? 'public',
    operator: { schema: options.schema ?? options.media?.schema ?? 'public' },
  });
  await app.ready();
  return app;
}

export type TestApp = {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: Db;
  schema: string;
  logs: string[];
  close: () => Promise<void>;
};

/**
 * Full app against an isolated schema. Logs are captured through the app's log sink so
 * tests can assert that credentials, tokens and message content never reach logging.
 */
export async function createTestApp(
  overrides: Partial<Config> = {},
  appDeps: { auth?: { login?: LoginLimiterOptions } } = {},
): Promise<TestApp> {
  const { db, schema, close } = await createTestDb();
  const logs: string[] = [];
  const app = await buildApp({
    config: testConfig(overrides),
    db,
    operator: { schema },
    auth: appDeps.auth,
    logSink: (line) => logs.push(line),
  });
  await app.ready();
  return {
    app,
    db,
    schema,
    logs,
    close: async () => {
      await app.close();
      await close();
    },
  };
}
