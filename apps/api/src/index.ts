import { buildApp, type AmocrmAppDeps } from './app.ts';
import { loadConfig } from './platform/config.ts';
import { createPool } from './platform/db.ts';
import { logEvent } from './platform/logger.ts';
import { InMemoryObjectStorage, S3ObjectStorage, type ObjectStorage } from './media/storage.ts';
import { createTokenCipher } from './integrations/amocrm/crypto.ts';
import { createOAuth } from './integrations/amocrm/oauth.ts';
import { createAmocrmWorkflowClient } from './integrations/amocrm/workflow-client.ts';
import { createPipelineCatalogue } from './integrations/amocrm/pipelines.ts';
import { drainTelegramInbox } from './telegram/processor.ts';
import { drainAmocrmReplies } from './integrations/amocrm/replies.ts';
import { createCrmDirectoryClient } from './integrations/amocrm/directory-client.ts';
import { createCrmOwnerResolver,type CrmOwnerResolver } from './integrations/amocrm/directory-owner.ts';
import { createAmocrmSyncClient } from './integrations/amocrm/sync-client.ts';
import {createAmoDriveReader} from './integrations/amocrm/drive-reader.ts';

const config = loadConfig();
const db = createPool(config.databaseUrl);

// S3 credentials are optional; without them media stays in-process (development only).
const storage: ObjectStorage =
  config.s3 && config.s3.accessKeyId && config.s3.secretAccessKey
    ? new S3ObjectStorage({
        endpoint: config.s3.endpoint,
        region: config.s3.region,
        bucket: config.s3.bucket,
        accessKeyId: config.s3.accessKeyId,
        secretAccessKey: config.s3.secretAccessKey,
        forcePathStyle: config.s3.forcePathStyle,
      })
    : new InMemoryObjectStorage(config.sessionSecret);

const remoteAllowedHosts = (process.env.MEDIA_REMOTE_ALLOWED_HOSTS ?? '')
  .split(',')
  .map((host) => host.trim())
  .filter((host) => host.length > 0);

// amoCRM webhooks need the channel-secret cipher; without a complete
// configuration the route is not registered rather than silently unverified.
const amocrmConfig = config.amocrm;
let amocrm: AmocrmAppDeps | undefined;
let crmOwnerResolver:CrmOwnerResolver|undefined;
if (amocrmConfig?.tokenKey && amocrmConfig.clientSecret && amocrmConfig.redirectUri && amocrmConfig.accountDomain) {
  const cipher = createTokenCipher(amocrmConfig.tokenKey);
  const oauth = createOAuth({
    db,
    cipher,
    fetch: globalThis.fetch,
    config: {
      clientId: amocrmConfig.clientId ?? '',
      clientSecret: amocrmConfig.clientSecret,
      redirectUri: amocrmConfig.redirectUri,
      accountDomain: amocrmConfig.accountDomain,
    },
  });
  amocrm = {
    cipher,
    schema: process.env.DB_SCHEMA ?? 'public',
    oauth,
    // The workflow client authenticates as the account that owns each conversation.
    workflowClient: createAmocrmWorkflowClient({
      accountDomain: amocrmConfig.accountDomain,
      getAccessToken: (input) => oauth.accessToken(input),
      fetch: globalThis.fetch,
    }),
    // Funnels are read from the account and cached briefly; the admin screen uses
    // this to offer real stages instead of free text.
    pipelines: createPipelineCatalogue({
      accountDomain: amocrmConfig.accountDomain,
      getAccessToken: (input) => oauth.accessToken(input),
      fetch: globalThis.fetch,
    }),
    directoryClient:createCrmDirectoryClient({accountDomain:amocrmConfig.accountDomain,
      getAccessToken:(input)=>oauth.accessToken(input),fetch:globalThis.fetch}),
    accountDomain: amocrmConfig.accountDomain,
    setupToken: amocrmConfig.setupToken,
    driveReader:createAmoDriveReader({accountDomain:amocrmConfig.accountDomain,
      getAccessToken:(scope)=>oauth.accessToken(scope),fetch:globalThis.fetch}),
    companyId: amocrmConfig.companyId,
  };
  crmOwnerResolver=createCrmOwnerResolver({
    findOpenLeads:createAmocrmSyncClient({accountDomain:amocrmConfig.accountDomain,getAccessToken:(input)=>oauth.accessToken(input),fetch:globalThis.fetch}).findOpenLeads,
    readResponsible:amocrm.workflowClient!.readResponsible,
  });
}

const app = await buildApp({
  config,
  db,
  media: {
    schema: process.env.DB_SCHEMA ?? 'public',
    storage,
    // Empty allowlist disables remote fetch entirely.
    remoteFetch: remoteAllowedHosts.length > 0 ? { allowedHosts: remoteAllowedHosts } : null,
    archiveContractRef: process.env.ARCHIVE_CONTRACT_REF ?? null,
  },
  amocrm,
  operator: { schema: process.env.DB_SCHEMA ?? 'public' },
  metricsToken: config.metricsToken,
  metricsSchema: process.env.DB_SCHEMA ?? 'public',
});

// The webhook only commits the raw update to the durable inbox. This drain is what
// turns committed updates into conversations, messages, work items and obligations.
// A failed pass leaves the events pending, so the next tick retries them instead of
// losing an acknowledged update.
const INBOX_DRAIN_INTERVAL_MS = Number.parseInt(process.env.TELEGRAM_INBOX_INTERVAL_MS ?? '2000', 10);
const inboxSchema = process.env.DB_SCHEMA ?? 'public';
// A pass that outlives the interval must not overlap the next one: overlapping
// passes race for the same rows and multiply connections and buffered work.
let draining = false;
const inboxTimer = setInterval(() => {
  if (draining) return;
  draining = true;
  void drainTelegramInbox(db, { schema: inboxSchema })
    .then(async(result) => {
      if (result.processed > 0) {
        logEvent('info', 'telegram.inbox.drained', { ...result });
      }
      const replies=await drainAmocrmReplies(db,{schema:inboxSchema,outboundEnabled:config.outboundEnabled,
        outboundPolicy:config.outboundPolicy??{mode:'off'},resolveOwner:crmOwnerResolver});
      if (replies.processed>0) logEvent('info','amocrm.replies.drained',replies);
    })
    .catch((error: unknown) => {
      logEvent('error', 'telegram.inbox.drain_failed', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
    })
    .finally(() => {
      draining = false;
    });
}, INBOX_DRAIN_INTERVAL_MS);
inboxTimer.unref();

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logEvent('info', 'process.shutdown', { signal });
  clearInterval(inboxTimer);
  try {
    await app.close();
  } finally {
    await db.end();
  }
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: config.port, host: config.host });
logEvent('info', 'process.started', { port: config.port, outboundEnabled: config.outboundEnabled });
