/**
 * `npm run readiness` — human-readable launch readiness report.
 *
 * Loads the configuration, checks the migration ledger when the database is
 * reachable, and prints what still blocks the launch. Exits with 1 when at least
 * one blocker remains and 0 otherwise.
 *
 * The report is safe to paste into a ticket: it contains no secret values, only
 * the names of the environment variables that are missing.
 */
import { loadConfig } from './platform/config.ts';
import { createPool } from './platform/db.ts';
import {
  assessReadiness,
  type ReadinessConfig,
  type ReadinessFacts,
  type ReadinessItem,
  type ReadinessReport,
} from './platform/readiness.ts';

const SCHEMA_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value === '') return fallback;
  return value === '1' || value.toLowerCase() === 'true' || value.toLowerCase() === 'yes';
}

/**
 * Lenient mirror of `loadConfig` used only when the strict loader throws. It
 * lets the report explain *which* value is missing instead of the CLI dying
 * before it can print anything.
 */
function configFromEnv(env: NodeJS.ProcessEnv): ReadinessConfig {
  const s3Bucket = env.S3_BUCKET ?? '';
  const amocrmClientId = env.AMOCRM_CLIENT_ID ?? '';
  const telegramToken = env.TELEGRAM_BOT_TOKEN ?? '';
  const whatsappAppSecret = env.WHATSAPP_APP_SECRET ?? '';
  const whatsappAccessToken = env.WHATSAPP_ACCESS_TOKEN ?? '';
  const whatsappPhoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID ?? '';
  const maxAccessToken = env.MAX_ACCESS_TOKEN ?? '';
  const maxWebhookSecret = env.MAX_WEBHOOK_SECRET ?? '';
  const vkGroupId = Number.parseInt(env.VK_GROUP_ID ?? '', 10);
  const vkAccessToken = env.VK_ACCESS_TOKEN ?? '';
  const vkSecret = env.VK_SECRET ?? '';
  const vkConfirmationCode = env.VK_CONFIRMATION_CODE ?? '';

  return {
    databaseUrl: env.DATABASE_URL ?? '',
    sessionSecret: env.SESSION_SECRET ?? '',
    secureCookies: bool(env.SECURE_COOKIES, true),
    adminBootstrapToken: env.ADMIN_BOOTSTRAP_TOKEN ?? null,
    s3: s3Bucket
      ? {
          bucket: s3Bucket,
          accessKeyId: env.S3_ACCESS_KEY_ID ?? null,
          secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? null,
        }
      : null,
    amocrm: amocrmClientId
      ? {
          clientId: amocrmClientId,
          clientSecret: env.AMOCRM_CLIENT_SECRET ?? null,
          redirectUri: env.AMOCRM_REDIRECT_URI ?? null,
          accountDomain: env.AMOCRM_ACCOUNT_DOMAIN ?? null,
          tokenKey: env.AMOCRM_TOKEN_KEY ?? null,
        }
      : null,
    telegram: telegramToken
      ? {
          botToken: telegramToken,
          webhookSecret: env.TELEGRAM_WEBHOOK_SECRET ?? null,
        }
      : null,
    whatsapp:
      whatsappAppSecret && whatsappAccessToken && whatsappPhoneNumberId
        ? {
            appSecret: whatsappAppSecret,
            accessToken: whatsappAccessToken,
            phoneNumberId: whatsappPhoneNumberId,
            verifyToken: env.WHATSAPP_VERIFY_TOKEN ?? null,
          }
        : null,
    max:
      maxAccessToken && maxWebhookSecret
        ? { accessToken: maxAccessToken, webhookSecret: maxWebhookSecret }
        : null,
    vk:
      Number.isFinite(vkGroupId) && vkGroupId > 0 && vkAccessToken && vkSecret && vkConfirmationCode
        ? {
            groupId: vkGroupId,
            accessToken: vkAccessToken,
            secret: vkSecret,
            confirmationCode: vkConfirmationCode,
          }
        : null,
    metricsToken: env.METRICS_TOKEN && env.METRICS_TOKEN.length > 0 ? env.METRICS_TOKEN : null,
    outboundEnabled: bool(env.OUTBOUND_ENABLED, false),
  };
}

function errorCode(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

/**
 * Reads the migration ledger. Any failure is reported as a fact, never thrown:
 * a missing or unreachable database must not crash the readiness command.
 */
async function collectDatabaseFacts(
  config: ReadinessConfig,
  env: NodeJS.ProcessEnv,
): Promise<ReadinessFacts> {
  const databaseUrl = (config.databaseUrl ?? '').trim();
  if (!databaseUrl) return {};

  const schema = env.DB_SCHEMA && env.DB_SCHEMA.length > 0 ? env.DB_SCHEMA : 'public';
  if (!SCHEMA_PATTERN.test(schema)) {
    // The schema name is interpolated into SQL, so an invalid one is treated as
    // an unreachable database rather than risking a malformed statement.
    return { databaseReachable: false };
  }

  const db = createPool(databaseUrl, { max: 1, connectionTimeoutMillis: 3_000 });
  try {
    const { rows } = await db.query<{ version: string }>(
      `SELECT version FROM "${schema}".schema_migrations ORDER BY version`,
    );
    return {
      databaseReachable: true,
      appliedMigrationVersions: rows.map((row) => Number(row.version)),
    };
  } catch (error) {
    const code = errorCode(error);
    // 42P01 = undefined_table, 3F000 = invalid_schema_name. Both mean the
    // ledger does not exist yet, i.e. no migration has been applied.
    if (code === '42P01' || code === '3F000') {
      return { databaseReachable: true, appliedMigrationVersions: [] };
    }
    return { databaseReachable: false };
  } finally {
    await db.end().catch(() => undefined);
  }
}

function printItem(prefix: string, entry: ReadinessItem): void {
  console.log(`${prefix} [${entry.code}] ${entry.title}`);
  console.log(`    ${entry.detail}`);
  if (entry.envVars.length > 0) {
    console.log(`    Переменные: ${entry.envVars.join(', ')}`);
  }
}

function printSection(title: string, prefix: string, items: ReadinessItem[]): void {
  console.log('');
  console.log(`${title} (${items.length})`);
  if (items.length === 0) {
    console.log('  нет');
    return;
  }
  for (const entry of items) printItem(prefix, entry);
}

function printReport(report: ReadinessReport): void {
  console.log('Проверка готовности messengers2amo');
  console.log('='.repeat(60));
  console.log(report.ready ? 'Итог: ГОТОВО к запуску' : 'Итог: НЕ ГОТОВО к запуску');
  console.log(
    `Блокеры: ${report.blockers.length}, предупреждения: ${report.warnings.length}, ` +
      `необязательное: ${report.optional.length}`,
  );

  printSection('БЛОКЕРЫ — без них запускаться нельзя', '[BLOCKER]', report.blockers);
  printSection('ПРЕДУПРЕЖДЕНИЯ — запуск возможен, но часть функций выключена', '[WARNING]', report.warnings);
  printSection('НЕОБЯЗАТЕЛЬНОЕ — не влияет на запуск', '[OPTIONAL]', report.optional);

  console.log('');
  if (report.ready) {
    console.log('Все блокеры закрыты.');
  } else {
    console.log('Закройте блокеры выше и запустите проверку снова.');
  }
}

const env = process.env;
let config: ReadinessConfig;
try {
  config = loadConfig(env);
} catch {
  config = configFromEnv(env);
}

const database = await collectDatabaseFacts(config, env);
const report = assessReadiness({ config, database });
printReport(report);
process.exitCode = report.ready ? 0 : 1;
