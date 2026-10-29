import { loadConfig } from './platform/config.ts';
import { createPool, type Db } from './platform/db.ts';
import { logEvent } from './platform/logger.ts';
import { runSendWorker } from './telegram/send.ts';
import { createTelegramTransport, type TelegramTransport } from './telegram/transport.ts';
import { createTokenCipher } from './integrations/amocrm/crypto.ts';
import { createOAuth } from './integrations/amocrm/oauth.ts';
import { createProjectionDispatcher } from './integrations/amocrm/projection.ts';
import { AmocrmSync, OutboundQueue } from './integrations/amocrm/sync.ts';
import { createAmocrmSyncClient } from './integrations/amocrm/sync-client.ts';
import { loadChannelForConversation } from './integrations/amocrm/store.ts';
import { decryptTelegramCredentials } from './connections/telegram-setup.ts';
import { S3ObjectStorage } from './media/storage.ts';
import { createTelegramMediaHandlers, TELEGRAM_MEDIA_JOB_KIND } from './telegram/media-projection.ts';
import { createCrmOwnerResolver,type CrmOwnerResolver } from './integrations/amocrm/directory-owner.ts';
import { createAmocrmWorkflowClient } from './integrations/amocrm/workflow-client.ts';
import { createCrmFilesClient } from './integrations/amocrm/files-client.ts';
import { createCaptureFileProjection } from './integrations/amocrm/capture-files.ts';
import { createMessageProjectionRouter } from './integrations/amocrm/projection-routing.ts';
import {outboundConnectionAllowed} from './platform/outbound-policy.ts';
import {crmDriveMediaUrl} from './media/crm-drive-access.ts';
import {crmAvatarUrl} from './media/crm-avatar-access.ts';
import type {InboundMessageInput} from './integrations/amocrm/sync.ts';

/**
 * Outbox worker. The API only accepts commands and commits them; this process is
 * the single place that talks to a provider, so a request handler can never block
 * on a network call and a crash here cannot lose an accepted command.
 *
 * It polls rather than exiting when the queue is empty: a one-shot cron would add
 * latency and make lease handling harder to reason about.
 *
 * One pass serves every active Telegram connection, because the queue is keyed by
 * connection and each connection carries its own credentials.
 */
const config = loadConfig();
// Projection holds its domain transaction while durable creation intents commit
// independently. Those writes need a second connection even with one job at a time.
const db = createPool(config.databaseUrl, { max: 2 });
const schema = process.env.DB_SCHEMA ?? 'public';
const workerId = process.env.WORKER_ID ?? `worker-${process.pid}`;
const intervalMs = Number.parseInt(process.env.WORKER_INTERVAL_MS ?? '1000', 10);
const leaseMs = Number.parseInt(process.env.WORKER_LEASE_MS ?? '60000', 10);
/** Jobs projected per tick; the cap keeps a long CRM backlog from starving the send pass. */
const projectionBatch = Number.parseInt(process.env.WORKER_PROJECTION_BATCH ?? '20', 10);

const mediaStorage = config.s3?.accessKeyId && config.s3.secretAccessKey ? new S3ObjectStorage({
  endpoint:config.s3.endpoint,region:config.s3.region,bucket:config.s3.bucket,
  accessKeyId:config.s3.accessKeyId,secretAccessKey:config.s3.secretAccessKey,forcePathStyle:config.s3.forcePathStyle,
}) : null;
const media = createTelegramMediaHandlers({
  db,schema,storage:mediaStorage,sessionSecret:config.sessionSecret,
  crmMediaBaseUrl:config.crmMediaBaseUrl,
  resolveBotToken:botTokenFor,fetch:globalThis.fetch,archiveContractRef:process.env.ARCHIVE_CONTRACT_REF ?? null,
});
// Archive work does not depend on OAuth or CRM import policy, and creates no CRM effect.
const mediaArchive = mediaStorage ? new OutboundQueue({
  db,schema,workerId,leaseMs,jobKinds:[TELEGRAM_MEDIA_JOB_KIND],dispatch:media.archiveMessage,
}) : null;
let crmOwnerResolver:CrmOwnerResolver|undefined;

/**
 * The CRM projection queue. Without a complete amoCRM configuration there is
 * nothing to project into, so the pass stays off rather than claiming jobs it
 * cannot dispatch.
 */
function buildProjectionQueue(): OutboundQueue | null {
  const amocrm = config.amocrm;
  if (!amocrm?.tokenKey || !amocrm.clientSecret || !amocrm.redirectUri || !amocrm.accountDomain) return null;
  const cipher = createTokenCipher(amocrm.tokenKey);
  const oauth = createOAuth({
    db,
    cipher,
    fetch: globalThis.fetch,
    config: {
      clientId: amocrm.clientId ?? '',
      clientSecret: amocrm.clientSecret,
      redirectUri: amocrm.redirectUri,
      accountDomain: amocrm.accountDomain,
    },
  });
  const ownerScope={accountDomain:amocrm.accountDomain,getAccessToken:(input:{companyId:string;accountId:string})=>oauth.accessToken(input),fetch:globalThis.fetch};
  crmOwnerResolver=createCrmOwnerResolver({findOpenLeads:createAmocrmSyncClient(ownerScope).findOpenLeads,readResponsible:createAmocrmWorkflowClient(ownerScope).readResponsible});
  const syncClient = createAmocrmSyncClient({
    accountDomain: amocrm.accountDomain,
    getAccessToken: (input) => oauth.accessToken(input),
    fetch: globalThis.fetch,
    getChatScope: async (input) => {
      const row = await loadChannelForConversation(db, schema, input);
      if (!row) return null;
      return { scopeId: row.scope_id, channelSecret: cipher.decrypt(row.secret_enc) };
    },
  });
  const captureConnectionId = process.env.AMOCRM_LEAD_CAPTURE_CONNECTION_ID?.trim();
  const captureCompanyId = process.env.AMOCRM_LEAD_CAPTURE_COMPANY_ID?.trim();
  if (Boolean(captureConnectionId) !== Boolean(captureCompanyId)) throw new Error('lead_capture_scope_incomplete');
  const capture = captureConnectionId ? new AmocrmSync({ db, schema, client: syncClient, captureOnly: true }) : null;
  const sync = new AmocrmSync({ db, schema, client: syncClient });
  const prepareAvatar=async(input:InboundMessageInput):Promise<InboundMessageInput>=>{
    if(!config.crmMediaBaseUrl||input.direction!=='in')return input;
    const profile=(await db.query<{binding_epoch:string}>(
      `SELECT binding_epoch FROM "${schema}".conversations WHERE company_id=$1 AND id=$2 AND chat_kind='private' AND external_chat_id ~ '^[1-9][0-9]*$'`,
      [input.companyId,input.conversationId])).rows[0];
    return profile?{...input,senderAvatarUrl:crmAvatarUrl({companyId:input.companyId,accountId:input.accountId,conversationId:input.conversationId,
      bindingEpoch:Number(profile.binding_epoch),baseUrl:config.crmMediaBaseUrl,secret:config.sessionSecret})}:input;
  };
  const projectInboundMessage = createMessageProjectionRouter({
    db, schema, nativeProject: async(input) => sync.projectInboundMessage(await prepareAvatar(input)), prepareMessage: media.prepareMessage,
    capture: capture && captureCompanyId && captureConnectionId ? {
      companyId: captureCompanyId, connectionId: captureConnectionId,
      projectMessage: (input) => capture.projectInboundMessage(input),
      wrapFiles: process.env.AMOCRM_CAPTURE_FILES_ENABLED === 'true' ? (projectMessage) => createCaptureFileProjection({
        db, schema, projectMessage, resolveBotToken: botTokenFor,
        ensureBinding:async(input)=>(await loadChannelForConversation(db,schema,input))?sync.ensureInboundBinding(await prepareAvatar(input)):capture!.projectInboundMessage(input),
        fileUrl:(input)=>crmDriveMediaUrl({...input,baseUrl:config.crmMediaBaseUrl,secret:config.sessionSecret}),
        files: createCrmFilesClient(ownerScope), fetch: globalThis.fetch,
      }) : undefined,
    } : undefined,
  });
  return new OutboundQueue({
    db,
    schema,
    workerId,
    leaseMs,
    dispatch: createProjectionDispatcher({
      sync: {
        applyCrmEvent: (input) => sync.applyCrmEvent(input),
        projectInboundMessage,
      },
    }),
  });
}

const projection = buildProjectionQueue();

type ActiveConnection = { companyId: string; connectionId: string; credentialRef: string | null };

let stopping = false;
let timer: NodeJS.Timeout | null = null;

function qualified(table: string): string {
  return `"${schema}"."${table}"`;
}

async function activeTelegramConnections(db: Db): Promise<ActiveConnection[]> {
  const { rows } = await db.query<{ company_id: string; id: string; credential_ref: string | null }>(
    `SELECT company_id, id, credential_ref FROM ${qualified('connections')}
      WHERE channel_mode = 'telegram_bot'
        AND state IN ('active', 'degraded')
        AND send_enabled = true
      ORDER BY company_id, id`,
  );
  return rows.map((row) => ({ companyId: row.company_id, connectionId: row.id, credentialRef: row.credential_ref }));
}

function botTokenFor(connection: ActiveConnection): string | null {
  let botToken=config.telegram?.botToken ?? '';
  if (connection.credentialRef?.startsWith('chancred_v1.')) {
    if (!config.amocrm?.tokenKey) return null;
    try {
      botToken=decryptTelegramCredentials(createTokenCipher(config.amocrm.tokenKey),connection.credentialRef,connection).botToken;
    } catch {
      logEvent('error','worker.credentials_unavailable',{connectionId:connection.connectionId});
      return null;
    }
  }
  if (!botToken) return null;
  return botToken;
}

function transportFor(connection: ActiveConnection): TelegramTransport | null {
  const botToken=botTokenFor(connection);
  if (!botToken) return null;
  return createTelegramTransport({
    apiBase: config.telegram?.apiBase ?? 'https://api.telegram.org',
    botToken,
    fetch: globalThis.fetch,
  });
}

/**
 * Sends queued Telegram messages.
 *
 * The outbound gateway is closed by default: while `OUTBOUND_ENABLED` is false
 * this pass must not claim an outbox job and must not reach a provider, so a
 * CRM-only run cannot deliver anything to a customer. The check is fail-closed
 * and sits here, at the pass that owns the provider call: the API only accepts
 * commands, so a job left in `pending` is harmless until a worker with the
 * gateway open claims it.
 *
 * The CRM projection and the media archive are separate passes and keep
 * running while the gateway is closed: neither of them delivers a message to a
 * customer.
 */
async function runTelegramPass(): Promise<void> {
  if (!config.outboundEnabled) {
    logEvent('info', 'worker.outbound_disabled', { workerId });
    return;
  }
  const outboundPolicy=config.outboundPolicy??{mode:'off' as const};
  const connections = await activeTelegramConnections(db);
  if (connections.length === 0) return;
  for (const connection of connections) {
    if (stopping) return;
    if(!outboundConnectionAllowed(outboundPolicy,connection))continue;
    const transport=transportFor(connection);
    if (!transport) {
      logEvent('warn','worker.no_transport',{workerId,connectionId:connection.connectionId,reason:'telegram_not_configured'});
      continue;
    }
    const result = await runSendWorker(db, {
      companyId: connection.companyId,
      connectionId: connection.connectionId,
      owner: workerId,
      leaseMs,
      transport,
      schema,
      resolveCrmOwner:crmOwnerResolver,
      outboundPolicy,
    });
    if (result.claimed > 0) {
      logEvent('info', 'worker.batch', {
        workerId,
        connectionId: connection.connectionId,
        claimed: result.claimed,
        sent: result.sent,
        failed: result.failed,
        unknown: result.unknown,
        rateLimited: result.rateLimited,
      });
    }
  }
}

/**
 * Drains the CRM projection queue. The queue owns leasing, retries and the
 * backoff, so a failing job is left for a later tick instead of being retried
 * here; this loop only bounds how much one tick may do.
 */
async function runProjectionPass(): Promise<void> {
  if (!projection) return;
  let processed = 0;
  while (!stopping && processed < projectionBatch) {
    const result = await projection.runOnce();
    if (result.attempted === 0) break;
    processed += result.attempted;
    logEvent('info', 'worker.projection', { workerId, ...result });
  }
}

async function runMediaArchivePass(): Promise<void> {
  if (!mediaArchive) return;
  for (let processed=0;!stopping && processed<projectionBatch;processed++) {
    const result = await mediaArchive.runOnce();
    if (result.attempted === 0) break;
    logEvent('info','worker.media_archive',{workerId,...result});
  }
}

async function tick(): Promise<void> {
  if (stopping) return;
  try {
    await runTelegramPass();
    if (stopping) return;
    await runMediaArchivePass();
    if (stopping) return;
    await runProjectionPass();
  } catch (error) {
    logEvent('error', 'worker.tick_failed', {
      workerId,
      code: (error as { code?: string }).code ?? 'worker_error',
    });
  } finally {
    if (!stopping) timer = setTimeout(() => void tick(), intervalMs);
  }
}

function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  if (timer) clearTimeout(timer);
  logEvent('info', 'worker.shutdown', { signal, workerId });
  void db.end().finally(() => process.exit(0));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

logEvent('info', 'worker.started', {
  workerId,
  intervalMs,
  leaseMs,
  schema,
  outboundEnabled: config.outboundEnabled,
  projectionEnabled: projection !== null,
  mediaArchiveEnabled: mediaArchive !== null,
  projectionBatch,
});
void tick();
