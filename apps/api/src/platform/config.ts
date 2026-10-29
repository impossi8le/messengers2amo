import {readOutboundPolicy,type OutboundPolicy} from './outbound-policy.ts';

export type Config = {
  port: number;
  host: string;
  databaseUrl: string;
  sessionSecret: string;
  /** Public HTTPS origin serving deferred amoCRM attachment downloads. */
  crmMediaBaseUrl?: string | null;
  sessionTtlSeconds: number;
  secureCookies: boolean;
  trustedProxy: boolean;
  adminBootstrapToken: string | null;
  s3: {
    endpoint: string | null;
    region: string;
    bucket: string;
    accessKeyId: string | null;
    secretAccessKey: string | null;
    forcePathStyle: boolean;
  } | null;
  amocrm: {
    clientId: string | null;
    clientSecret: string | null;
    redirectUri: string | null;
    accountDomain: string | null;
    /** Key material for the AES-256-GCM credential envelope. */
    tokenKey?: string | null;
    /** Company id the integration belongs to. */
    companyId: string;
    /** One-time token allowing the OAuth flow before any staff account exists. */
    setupToken: string | null;
  } | null;
  telegram: {
    botToken: string | null;
    webhookSecret: string | null;
    apiBase: string;
  } | null;
  /** WhatsApp Cloud API inbound/outbound credentials; absent means the channel is off. */
  whatsapp?: {
    appSecret: string;
    accessToken: string;
    phoneNumberId: string;
    /** Meta webhook subscription token used by the GET challenge handshake. */
    verifyToken: string | null;
    apiBase?: string;
  } | null;
  /** MAX bot credentials; absent means the channel is off. */
  max?: {
    accessToken: string;
    webhookSecret: string;
    apiBase?: string;
  } | null;
  /** VK community Callback API credentials; absent means the channel is off. */
  vk?: {
    groupId: number;
    accessToken: string;
    secret: string;
    confirmationCode: string;
    apiBase?: string;
    apiVersion?: string;
  } | null;
  outboundEnabled: boolean;
  /** Always populated by loadConfig; optional for existing in-process fixtures. */
  outboundPolicy?: OutboundPolicy;
  /** Bearer token for /metrics; empty disables the route entirely. */
  metricsToken: string | null;
  /**
   * Bearer token for the internal CRM adapter routes. Empty disables the whole
   * group, so an unconfigured deployment cannot accept adapter traffic at all.
   */
  internalServiceToken?: string | null;
};

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value === '') return fallback;
  return value === '1' || value.toLowerCase() === 'true' || value.toLowerCase() === 'yes';
}

function int(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing_environment_variable:${name}`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL ?? '';
  if (!databaseUrl) throw new Error('missing_environment_variable:DATABASE_URL');

  const sessionSecret = required('SESSION_SECRET');
  if (sessionSecret.length < 32) throw new Error('session_secret_too_short');

  const s3Bucket = env.S3_BUCKET ?? '';
  const amocrmClientId = env.AMOCRM_CLIENT_ID ?? '';
  const telegramToken = env.TELEGRAM_BOT_TOKEN ?? '';
  const whatsappAppSecret = env.WHATSAPP_APP_SECRET ?? '';
  const whatsappAccessToken = env.WHATSAPP_ACCESS_TOKEN ?? '';
  const whatsappPhoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID ?? '';
  const maxAccessToken = env.MAX_ACCESS_TOKEN ?? '';
  const maxWebhookSecret = env.MAX_WEBHOOK_SECRET ?? '';
  const vkGroupId = int(env.VK_GROUP_ID, 0);
  const vkAccessToken = env.VK_ACCESS_TOKEN ?? '';
  const vkSecret = env.VK_SECRET ?? '';
  const vkConfirmationCode = env.VK_CONFIRMATION_CODE ?? '';

  return {
    port: int(env.PORT, 3000),
    host: env.HOST ?? '0.0.0.0',
    databaseUrl,
    sessionSecret,
    crmMediaBaseUrl: env.AMOCRM_MEDIA_BASE_URL?.trim() || null,
    sessionTtlSeconds: int(env.SESSION_TTL_SECONDS, 8 * 60 * 60),
    secureCookies: bool(env.SECURE_COOKIES, true),
    trustedProxy: bool(env.TRUSTED_PROXY, true),
    adminBootstrapToken: env.ADMIN_BOOTSTRAP_TOKEN ?? null,
    s3: s3Bucket
      ? {
          endpoint: env.S3_ENDPOINT ?? null,
          region: env.S3_REGION ?? 'us-east-1',
          bucket: s3Bucket,
          accessKeyId: env.S3_ACCESS_KEY_ID ?? null,
          secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? null,
          forcePathStyle: bool(env.S3_FORCE_PATH_STYLE, true),
        }
      : null,
    amocrm: amocrmClientId
      ? {
          clientId: amocrmClientId,
          clientSecret: env.AMOCRM_CLIENT_SECRET ?? null,
          redirectUri: env.AMOCRM_REDIRECT_URI ?? null,
          accountDomain: env.AMOCRM_ACCOUNT_DOMAIN ?? null,
          tokenKey: env.AMOCRM_TOKEN_KEY ?? null,
          companyId: env.AMOCRM_COMPANY_ID ?? 'default',
          setupToken: env.AMOCRM_SETUP_TOKEN ?? null,
        }
      : null,
    telegram: telegramToken
      ? {
          botToken: telegramToken,
          webhookSecret: env.TELEGRAM_WEBHOOK_SECRET ?? null,
          apiBase: env.TELEGRAM_API_BASE ?? 'https://api.telegram.org',
        }
      : null,
    // Each block is enabled only when every value needed to authenticate an
    // inbound webhook is present; a partial configuration would otherwise
    // register a route that can never verify a request.
    whatsapp:
      whatsappAppSecret && whatsappAccessToken && whatsappPhoneNumberId
        ? {
            appSecret: whatsappAppSecret,
            accessToken: whatsappAccessToken,
            phoneNumberId: whatsappPhoneNumberId,
            verifyToken: env.WHATSAPP_VERIFY_TOKEN || null,
            apiBase: env.WHATSAPP_API_BASE || undefined,
          }
        : null,
    max:
      maxAccessToken && maxWebhookSecret
        ? {
            accessToken: maxAccessToken,
            webhookSecret: maxWebhookSecret,
            apiBase: env.MAX_API_BASE || undefined,
          }
        : null,
    vk:
      vkGroupId > 0 && vkAccessToken && vkSecret && vkConfirmationCode
        ? {
            groupId: vkGroupId,
            accessToken: vkAccessToken,
            secret: vkSecret,
            confirmationCode: vkConfirmationCode,
            apiBase: env.VK_API_BASE || undefined,
            apiVersion: env.VK_API_VERSION || undefined,
          }
        : null,
    outboundEnabled: bool(env.OUTBOUND_ENABLED, false),
    outboundPolicy: readOutboundPolicy(env),
    metricsToken: env.METRICS_TOKEN && env.METRICS_TOKEN.length > 0 ? env.METRICS_TOKEN : null,
    internalServiceToken:
      env.INTERNAL_SERVICE_TOKEN && env.INTERNAL_SERVICE_TOKEN.length > 0
        ? env.INTERNAL_SERVICE_TOKEN
        : null,
  };
}
