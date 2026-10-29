/**
 * Launch readiness assessment.
 *
 * Pure and synchronous: it reads only the configuration it is given and the
 * optional facts about the database. It never opens a connection, never reads
 * the environment and never performs I/O, so it is safe to call from tests and
 * from the CLI alike.
 *
 * The report never contains secret values. Items only carry a stable code, the
 * affected area, a human-readable title/detail and the names of the environment
 * variables that would close the gap.
 */

import { MIGRATION_LEDGER } from './migrate.ts';

export type ReadinessArea =
  | 'database'
  | 'amocrm'
  | 'telegram'
  | 'whatsapp'
  | 'max'
  | 'vk'
  | 'media'
  | 'security'
  | 'ops';

export type ReadinessItem = {
  code: string;
  area: ReadinessArea;
  title: string;
  detail: string;
  envVars: string[];
};

export type ReadinessReport = {
  /** True only when every blocker is closed. Warnings and optional items do not affect it. */
  ready: boolean;
  /** Without these the service must not be launched. */
  blockers: ReadinessItem[];
  /** It can start, but some functionality will be degraded. */
  warnings: ReadinessItem[];
  /** Non-mandatory capabilities and deliberate gates. */
  optional: ReadinessItem[];
};

/**
 * Structural subset of `Config` from `platform/config.ts`. Every field is
 * optional so the CLI can report a missing value instead of crashing before the
 * assessment starts. A full `Config` is assignable to this type.
 */
export type ReadinessConfig = {
  databaseUrl?: string | null;
  sessionSecret?: string | null;
  secureCookies?: boolean | null;
  adminBootstrapToken?: string | null;
  s3?: {
    bucket?: string | null;
    accessKeyId?: string | null;
    secretAccessKey?: string | null;
  } | null;
  amocrm?: {
    clientId?: string | null;
    clientSecret?: string | null;
    redirectUri?: string | null;
    accountDomain?: string | null;
    tokenKey?: string | null;
  } | null;
  telegram?: {
    botToken?: string | null;
    webhookSecret?: string | null;
  } | null;
  whatsapp?: {
    appSecret?: string | null;
    accessToken?: string | null;
    phoneNumberId?: string | null;
    verifyToken?: string | null;
  } | null;
  max?: {
    accessToken?: string | null;
    webhookSecret?: string | null;
  } | null;
  vk?: {
    groupId?: number | null;
    accessToken?: string | null;
    secret?: string | null;
    confirmationCode?: string | null;
  } | null;
  metricsToken?: string | null;
  outboundEnabled?: boolean | null;
  internalServiceToken?: string | null;
};

export type ReadinessFacts = {
  /** False when the connection or the schema check failed. */
  databaseReachable?: boolean | null;
  /** Versions present in `<schema>.schema_migrations`. Omit when not checked. */
  appliedMigrationVersions?: readonly number[] | null;
};

export type ReadinessInput = {
  config: ReadinessConfig;
  database?: ReadinessFacts | null;
};

/**
 * The migration ledger the API expects. Taken from the runner's own registry so a
 * new migration cannot be forgotten here; the registry is a literal list, so the
 * assessment stays pure and reads no files.
 */
export const REQUIRED_MIGRATIONS = MIGRATION_LEDGER;

const SESSION_SECRET_MIN_LENGTH = 32;

function present(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function item(
  code: string,
  area: ReadinessArea,
  title: string,
  detail: string,
  envVars: string[],
): ReadinessItem {
  return { code, area, title, detail, envVars };
}

export function assessReadiness(input: ReadinessInput): ReadinessReport {
  const { config } = input;
  const facts = input.database ?? null;
  const blockers: ReadinessItem[] = [];
  const warnings: ReadinessItem[] = [];
  const optional: ReadinessItem[] = [];

  // --- database -----------------------------------------------------------
  if (!present(config.databaseUrl)) {
    blockers.push(
      item(
        'database_url_missing',
        'database',
        'Не задана строка подключения к базе',
        'DATABASE_URL пуст. API не сможет подключиться к PostgreSQL и не запустится.',
        ['DATABASE_URL'],
      ),
    );
  } else if (facts && facts.databaseReachable === false) {
    blockers.push(
      item(
        'database_unreachable',
        'database',
        'База данных недоступна',
        'Не удалось подключиться к PostgreSQL или прочитать схему. Проверьте DATABASE_URL, DB_SCHEMA и доступность сервера.',
        ['DATABASE_URL', 'DB_SCHEMA'],
      ),
    );
  } else if (facts && Array.isArray(facts.appliedMigrationVersions)) {
    const applied = new Set(facts.appliedMigrationVersions);
    const missing = REQUIRED_MIGRATIONS.filter((migration) => !applied.has(migration.version));
    if (missing.length > 0) {
      const list = missing.map((migration) => `${migration.version} (${migration.name})`).join(', ');
      blockers.push(
        item(
          'database_migrations_incomplete',
          'database',
          'Применены не все миграции',
          `Не применены миграции: ${list}. Запустите npm run migrate до старта API.`,
          ['DATABASE_URL', 'DB_SCHEMA'],
        ),
      );
    }
  } else if (present(config.databaseUrl)) {
    optional.push(
      item(
        'database_migrations_unverified',
        'database',
        'Состояние миграций не проверено',
        'Факты о применённых миграциях не переданы, поэтому полнота схемы не подтверждена.',
        ['DATABASE_URL', 'DB_SCHEMA'],
      ),
    );
  }

  // --- security -----------------------------------------------------------
  if (!present(config.sessionSecret)) {
    blockers.push(
      item(
        'session_secret_missing',
        'security',
        'Не задан секрет сессий',
        'SESSION_SECRET пуст. Без него нельзя подписывать сессионные cookie сотрудников.',
        ['SESSION_SECRET'],
      ),
    );
  } else if ((config.sessionSecret ?? '').length < SESSION_SECRET_MIN_LENGTH) {
    blockers.push(
      item(
        'session_secret_too_short',
        'security',
        'Секрет сессий слишком короткий',
        `SESSION_SECRET короче ${SESSION_SECRET_MIN_LENGTH} символов. Сгенерируйте значение командой openssl rand -hex 32.`,
        ['SESSION_SECRET'],
      ),
    );
  }

  // There is no dedicated production/insecure switch in Config; the closest
  // signal is a disabled Secure cookie attribute on an HTTPS-only entrypoint.
  if (config.secureCookies === false) {
    warnings.push(
      item(
        'secure_cookies_disabled',
        'security',
        'Cookie передаются без флага Secure',
        'SECURE_COOKIES выключен. Публичный вход работает только по HTTPS, поэтому в production флаг должен быть включён.',
        ['SECURE_COOKIES'],
      ),
    );
  }

  if (present(config.adminBootstrapToken)) {
    optional.push(
      item(
        'admin_bootstrap_enabled',
        'security',
        'Включён bootstrap первого администратора',
        'ADMIN_BOOTSTRAP_TOKEN задан, поэтому POST /api/v2/auth/bootstrap может создать первого администратора. Токен нужен только пока в компании нет ни одного администратора; после создания первого администратора его следует очистить — без токена маршрут не регистрируется.',
        ['ADMIN_BOOTSTRAP_TOKEN'],
      ),
    );
  }

  // --- telegram (primary channel) ----------------------------------------
  const telegram = config.telegram ?? null;
  if (!telegram || !present(telegram.botToken)) {
    blockers.push(
      item(
        'telegram_bot_token_missing',
        'telegram',
        'Не настроен основной канал Telegram',
        'TELEGRAM_BOT_TOKEN пуст. Telegram — основной канал приёма и отправки сообщений, без него продукт не работает.',
        ['TELEGRAM_BOT_TOKEN'],
      ),
    );
  } else if (!present(telegram.webhookSecret)) {
    blockers.push(
      item(
        'telegram_webhook_secret_missing',
        'telegram',
        'Не задан секрет webhook Telegram',
        'TELEGRAM_WEBHOOK_SECRET пуст. Без него нельзя проверить подпись входящих запросов от Telegram.',
        ['TELEGRAM_WEBHOOK_SECRET'],
      ),
    );
  }

  // --- amoCRM (primary workspace) ----------------------------------------
  const amocrm = config.amocrm ?? null;
  const amocrmComplete =
    amocrm !== null &&
    present(amocrm.clientId) &&
    present(amocrm.clientSecret) &&
    present(amocrm.redirectUri) &&
    present(amocrm.accountDomain) &&
    present(amocrm.tokenKey);
  if (!amocrmComplete) {
    blockers.push(
      item(
        'amocrm_credentials_missing',
        'amocrm',
        'Нет доступов к amoCRM',
        'Чаты принимаются и отправляются, но синхронизации контактов, сделок и нативных чатов CRM не будет. Доступы выдаёт владелец аккаунта — это внешний блокер.',
        [
          'AMOCRM_CLIENT_ID',
          'AMOCRM_CLIENT_SECRET',
          'AMOCRM_REDIRECT_URI',
          'AMOCRM_ACCOUNT_DOMAIN',
          'AMOCRM_TOKEN_KEY',
        ],
      ),
    );
  }

  // --- optional messenger channels ---------------------------------------
  if (!config.whatsapp) {
    warnings.push(
      item(
        'whatsapp_disabled',
        'whatsapp',
        'Канал WhatsApp выключен',
        'Нет полного набора доступов WhatsApp Cloud API. Канал не принимает и не отправляет сообщения.',
        ['WHATSAPP_APP_SECRET', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_VERIFY_TOKEN'],
      ),
    );
  }

  if (!config.max) {
    warnings.push(
      item(
        'max_disabled',
        'max',
        'Канал MAX выключен',
        'Нет полного набора доступов MAX Bot API. Канал не принимает и не отправляет сообщения.',
        ['MAX_ACCESS_TOKEN', 'MAX_WEBHOOK_SECRET'],
      ),
    );
  }

  if (!config.vk) {
    warnings.push(
      item(
        'vk_disabled',
        'vk',
        'Канал VK выключен',
        'Нет полного набора доступов VK Callback API. Канал не принимает и не отправляет сообщения.',
        ['VK_GROUP_ID', 'VK_ACCESS_TOKEN', 'VK_SECRET', 'VK_CONFIRMATION_CODE'],
      ),
    );
  }

  // --- media --------------------------------------------------------------
  const s3 = config.s3 ?? null;
  const s3Complete = s3 !== null && present(s3.bucket) && present(s3.accessKeyId) && present(s3.secretAccessKey);
  if (!s3Complete) {
    warnings.push(
      item(
        'media_storage_in_memory',
        'media',
        'Вложения хранятся в памяти процесса',
        'S3 не настроен, поэтому медиа лежит в памяти и исчезнет при перезапуске. Для production нужен S3-совместимый бакет.',
        ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'],
      ),
    );
  }

  // --- ops ----------------------------------------------------------------
  if (!present(config.metricsToken)) {
    warnings.push(
      item(
        'metrics_token_missing',
        'ops',
        'Метрики не защищены и выключены',
        'METRICS_TOKEN пуст. Маршрут /metrics отвечает 404, поэтому мониторинг и алерты не работают.',
        ['METRICS_TOKEN'],
      ),
    );
  }

  if (config.outboundEnabled === false) {
    optional.push(
      item(
        'outbound_gate_closed',
        'ops',
        'Исходящая отправка закрыта',
        'OUTBOUND_ENABLED выключен. Сообщения не уходят во внешние каналы, пока шлюз не открыт после smoke-проверок.',
        ['OUTBOUND_ENABLED'],
      ),
    );
  }

  if (!present(config.internalServiceToken)) {
    optional.push(
      item(
        'internal_crm_disabled',
        'amocrm',
        'Внутренний CRM-адаптер выключен',
        'INTERNAL_SERVICE_TOKEN пуст, поэтому /api/v2/internal/crm/* не регистрируются и отвечают 404. Нужно только если исходящие команды приходят от отдельного сервиса-адаптера; операторская консоль работает без него.',
        ['INTERNAL_SERVICE_TOKEN'],
      ),
    );
  }

  return {
    ready: blockers.length === 0,
    blockers,
    warnings,
    optional,
  };
}
