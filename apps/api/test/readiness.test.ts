import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assessReadiness,
  REQUIRED_MIGRATIONS,
  type ReadinessConfig,
  type ReadinessReport,
} from '../src/platform/readiness.ts';

const ALL_VERSIONS = REQUIRED_MIGRATIONS.map((migration) => migration.version);

// Fake values only: these strings must never appear in the report.
const SECRETS = {
  session: 'session-secret-value-do-not-print-0123456789',
  telegram: 'telegram-bot-token-do-not-print',
  telegramWebhook: 'telegram-webhook-secret-do-not-print',
  amocrmSecret: 'amocrm-client-secret-do-not-print',
  amocrmTokenKey: 'amocrm-token-key-do-not-print-0123456789',
  s3Access: 's3-access-key-do-not-print',
  s3Secret: 's3-secret-key-do-not-print',
  metrics: 'metrics-token-do-not-print',
};

function fullConfig(overrides: Partial<ReadinessConfig> = {}): ReadinessConfig {
  return {
    databaseUrl: 'postgresql://user:pass@localhost:5432/db',
    sessionSecret: SECRETS.session,
    secureCookies: true,
    adminBootstrapToken: null,
    s3: {
      bucket: 'media-bucket',
      accessKeyId: SECRETS.s3Access,
      secretAccessKey: SECRETS.s3Secret,
    },
    amocrm: {
      clientId: 'amocrm-client-id',
      clientSecret: SECRETS.amocrmSecret,
      redirectUri: 'https://example.test/oauth/amocrm',
      accountDomain: 'example',
      tokenKey: SECRETS.amocrmTokenKey,
    },
    telegram: {
      botToken: SECRETS.telegram,
      webhookSecret: SECRETS.telegramWebhook,
    },
    whatsapp: {
      appSecret: 'whatsapp-app-secret',
      accessToken: 'whatsapp-access-token',
      phoneNumberId: 'phone-number-id',
      verifyToken: 'whatsapp-verify-token',
    },
    max: {
      accessToken: 'max-access-token',
      webhookSecret: 'max-webhook-secret',
    },
    vk: {
      groupId: 123456,
      accessToken: 'vk-access-token',
      secret: 'vk-secret',
      confirmationCode: 'vk-confirmation',
    },
    metricsToken: SECRETS.metrics,
    ...overrides,
  };
}

function allMigrationsApplied() {
  return { databaseReachable: true, appliedMigrationVersions: [...ALL_VERSIONS] };
}

function codes(report: ReadinessReport): string[] {
  return [...report.blockers, ...report.warnings, ...report.optional].map((item) => item.code);
}

test('fully configured environment is ready and has no blockers', () => {
  const report = assessReadiness({ config: fullConfig(), database: allMigrationsApplied() });

  assert.equal(report.ready, true);
  assert.deepEqual(report.blockers, []);
  assert.deepEqual(report.warnings, []);
});

test('missing Telegram bot token is a blocker with the right code and env vars', () => {
  const report = assessReadiness({
    config: fullConfig({ telegram: null }),
    database: allMigrationsApplied(),
  });

  assert.equal(report.ready, false);
  const blocker = report.blockers.find((item) => item.code === 'telegram_bot_token_missing');
  assert.ok(blocker, JSON.stringify(report.blockers));
  assert.equal(blocker.area, 'telegram');
  assert.ok(blocker.envVars.includes('TELEGRAM_BOT_TOKEN'));
});

test('missing Telegram webhook secret is a blocker', () => {
  const report = assessReadiness({
    config: fullConfig({
      telegram: { botToken: SECRETS.telegram, webhookSecret: null },
    }),
    database: allMigrationsApplied(),
  });

  assert.equal(report.ready, false);
  const blocker = report.blockers.find((item) => item.code === 'telegram_webhook_secret_missing');
  assert.ok(blocker, JSON.stringify(report.blockers));
  assert.ok(blocker.envVars.includes('TELEGRAM_WEBHOOK_SECRET'));
});

test('missing amoCRM credentials is an owner-side blocker but explains chats still work', () => {
  const report = assessReadiness({
    config: fullConfig({ amocrm: null }),
    database: allMigrationsApplied(),
  });

  assert.equal(report.ready, false);
  const blocker = report.blockers.find((item) => item.code === 'amocrm_credentials_missing');
  assert.ok(blocker, JSON.stringify(report.blockers));
  assert.equal(blocker.area, 'amocrm');
  assert.match(blocker.detail, /чаты/i);
  assert.match(blocker.detail, /CRM/i);
  assert.ok(blocker.envVars.includes('AMOCRM_CLIENT_ID'));
});

test('incomplete migrations block startup and list the missing versions', () => {
  const report = assessReadiness({
    config: fullConfig(),
    database: { databaseReachable: true, appliedMigrationVersions: ALL_VERSIONS.slice(0, 10) },
  });

  assert.equal(report.ready, false);
  const blocker = report.blockers.find((item) => item.code === 'database_migrations_incomplete');
  assert.ok(blocker, JSON.stringify(report.blockers));
  assert.equal(blocker.area, 'database');
  assert.match(blocker.detail, /12/);
  assert.match(blocker.detail, /13/);
});

test('missing database URL is a database blocker', () => {
  const report = assessReadiness({
    config: fullConfig({ databaseUrl: '' }),
    database: null,
  });

  assert.equal(report.ready, false);
  assert.ok(report.blockers.some((item) => item.code === 'database_url_missing'));
});

test('unreachable database is a database blocker, not a crash', () => {
  const report = assessReadiness({
    config: fullConfig(),
    database: { databaseReachable: false },
  });

  assert.equal(report.ready, false);
  const blocker = report.blockers.find((item) => item.code === 'database_unreachable');
  assert.ok(blocker, JSON.stringify(report.blockers));
});

test('empty METRICS_TOKEN is a warning, not a blocker', () => {
  const report = assessReadiness({
    config: fullConfig({ metricsToken: null }),
    database: allMigrationsApplied(),
  });

  assert.equal(report.ready, true);
  assert.deepEqual(report.blockers, []);
  const warning = report.warnings.find((item) => item.code === 'metrics_token_missing');
  assert.ok(warning, JSON.stringify(report.warnings));
  assert.ok(warning.envVars.includes('METRICS_TOKEN'));
});

test('in-memory media storage is a warning, not a blocker', () => {
  const report = assessReadiness({
    config: fullConfig({ s3: null }),
    database: allMigrationsApplied(),
  });

  assert.equal(report.ready, true);
  assert.deepEqual(report.blockers, []);
  const warning = report.warnings.find((item) => item.code === 'media_storage_in_memory');
  assert.ok(warning, JSON.stringify(report.warnings));
  assert.equal(warning.area, 'media');
});

test('optional channels are warnings while their credentials are absent', () => {
  const report = assessReadiness({
    config: fullConfig({ whatsapp: null, max: null, vk: null }),
    database: allMigrationsApplied(),
  });

  assert.equal(report.ready, true);
  assert.deepEqual(report.blockers, []);
  const warningCodes = report.warnings.map((item) => item.code);
  assert.ok(warningCodes.includes('whatsapp_disabled'));
  assert.ok(warningCodes.includes('max_disabled'));
  assert.ok(warningCodes.includes('vk_disabled'));
});

test('short session secret is a security blocker', () => {
  const report = assessReadiness({
    config: fullConfig({ sessionSecret: 'too-short' }),
    database: allMigrationsApplied(),
  });

  assert.equal(report.ready, false);
  const blocker = report.blockers.find((item) => item.code === 'session_secret_too_short');
  assert.ok(blocker, JSON.stringify(report.blockers));
  assert.ok(blocker.envVars.includes('SESSION_SECRET'));
});

test('the report never contains secret values', () => {
  const report = assessReadiness({
    config: fullConfig({ telegram: null, amocrm: null, s3: null, metricsToken: null }),
    database: { databaseReachable: false },
  });
  const serialized = JSON.stringify(report);

  for (const secret of Object.values(SECRETS)) {
    assert.equal(serialized.includes(secret), false, `report leaked a secret: ${secret}`);
  }
  // The codes we emit are stable and documented.
  assert.ok(codes(report).includes('database_unreachable'));
});
