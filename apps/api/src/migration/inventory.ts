// Migration inventory (#17): a typed, pseudonymous registry of the connections that
// currently serve production traffic. The registry is deliberately allowed to contain
// incomplete rows (owner "UNKNOWN", unknown mode): the owner fills it in gradually.
// Validation is the gate that refuses dangerous configurations before a cutover.
//
// Two invariants are safety-critical and checked across rows, not per row:
//   1. one asset (phone number, bot, community) has at most one active outbound sender;
//   2. one asset has at most one active inbound receiver, and it is never webhook + polling.
//
// No real phone numbers, tokens or client identifiers belong in this registry. Aliases
// and asset aliases are pseudonyms; real values stay in the protected company vault.

import type { Db, Tx } from '../platform/db.ts';

export const INVENTORY_CHANNELS = ['telegram', 'whatsapp', 'max', 'vk'] as const;
export type InventoryChannel = (typeof INVENTORY_CHANNELS)[number];

export const INVENTORY_ENVIRONMENTS = ['production', 'test'] as const;
export type InventoryEnvironment = (typeof INVENTORY_ENVIRONMENTS)[number];

/** How the current system receives events for the asset. */
export const INBOUND_TRANSPORTS = ['webhook', 'polling', 'callback', 'long_poll', 'none', 'unknown'] as const;
export type InboundTransport = (typeof INBOUND_TRANSPORTS)[number];

/** Which system is allowed to send on behalf of the asset. */
export const OUTBOUND_OWNERS = ['wazzup', 'new_contour', 'amocrm', 'manual', 'none', 'unknown'] as const;
export type OutboundOwner = (typeof OUTBOUND_OWNERS)[number];

export const HISTORY_EXPORT_STATES = ['available', 'partial', 'unavailable', 'unknown'] as const;
export type HistoryExportState = (typeof HISTORY_EXPORT_STATES)[number];

export type InventoryCapabilities = {
  /** Uses group chats, not only one-to-one dialogs. */
  groups: boolean;
  /** Sends or receives attachments. */
  files: boolean;
  /** Uses provider-approved message templates. */
  templates: boolean;
  /** Starts conversations first (outbound-initiated), not only replies. */
  outboundInitiated: boolean;
};

export type InventoryConnectionInput = {
  companyId: string;
  /** Pseudonym of this connection, e.g. WA-PROD-01. Unique inside a company. */
  alias: string;
  channel: InventoryChannel;
  /** Provider/API mode, e.g. whatsapp_cloud, telegram_bot, vk_community, max_bot. */
  mode: string;
  environment: InventoryEnvironment;
  /** False for retired rows kept for history; inactive rows never create conflicts. */
  active: boolean;
  /** Pseudonym of the underlying phone number, bot or community. */
  assetAlias: string;
  /** Accountable human, not a service name. "UNKNOWN" until confirmed. */
  owner: string;
  inbound: {
    transport: InboundTransport;
    /** Pseudonym of the system that receives events, e.g. wazzup. */
    subscriber: string | null;
    enabled: boolean;
  };
  outbound: {
    owner: OutboundOwner;
    enabled: boolean;
  };
  crmProjection: {
    owner: string | null;
    enabled: boolean;
  };
  capabilities: InventoryCapabilities;
  historyExport: HistoryExportState;
  notes?: string | null;
};

export type InventoryConnection = InventoryConnectionInput & {
  updatedAt: string;
};

export type InventoryIssueCode =
  | 'MISSING_REQUIRED_FIELD'
  | 'UNKNOWN_REQUIRED_FIELD'
  | 'INVALID_FIELD_VALUE'
  | 'DUPLICATE_ALIAS'
  | 'DUPLICATE_OUTBOUND_OWNER'
  | 'CONFLICTING_INBOUND_SUBSCRIBER'
  | 'WEBHOOK_POLLING_CONFLICT'
  | 'INBOUND_SUBSCRIBER_REQUIRED'
  | 'OUTBOUND_OWNER_REQUIRED'
  | 'DUPLICATE_CRM_PROJECTION_OWNER';

export type InventoryIssue = {
  code: InventoryIssueCode;
  severity: 'error' | 'warning';
  /** Pseudonym of the offending connection, when known. */
  alias: string | null;
  /** Pseudonym of the shared asset, when the issue is cross-row. */
  assetAlias: string | null;
  field: string | null;
  message: string;
};

export class InventoryStorageError extends Error {
  readonly code = 'INVENTORY_STORAGE_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'InventoryStorageError';
  }
}

const UNKNOWN = 'UNKNOWN';
const CAPABILITY_KEYS: readonly (keyof InventoryCapabilities)[] = ['groups', 'files', 'templates', 'outboundInitiated'];

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isKnown(value: unknown): boolean {
  const normalized = text(value);
  return normalized.length > 0 && normalized.toUpperCase() !== UNKNOWN;
}

function includes<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

function aliasOf(connection: InventoryConnectionInput): string | null {
  const alias = text(connection.alias);
  return alias.length > 0 ? alias : null;
}

function addIssue(
  issues: InventoryIssue[],
  connection: InventoryConnectionInput,
  code: InventoryIssueCode,
  severity: 'error' | 'warning',
  field: string | null,
  message: string,
  assetAlias: string | null = null,
): void {
  issues.push({ code, severity, alias: aliasOf(connection), assetAlias, field, message });
}

function requireText(
  issues: InventoryIssue[],
  connection: InventoryConnectionInput,
  field: string,
  value: unknown,
  options: { activeProduction: boolean },
): void {
  if (!text(value)) {
    addIssue(
      issues,
      connection,
      'MISSING_REQUIRED_FIELD',
      options.activeProduction ? 'error' : 'warning',
      field,
      `${field} is required`,
    );
    return;
  }
  if (options.activeProduction && !isKnown(value)) {
    addIssue(
      issues,
      connection,
      'UNKNOWN_REQUIRED_FIELD',
      'error',
      field,
      `${field} must be confirmed before a production cutover`,
    );
  }
}

function normalizeCapabilities(value: unknown): InventoryCapabilities {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
  return {
    groups: record.groups === true,
    files: record.files === true,
    templates: record.templates === true,
    outboundInitiated: record.outboundInitiated === true,
  };
}

function assetKey(connection: InventoryConnectionInput): string | null {
  const asset = text(connection.assetAlias);
  if (!asset) return null;
  return `${connection.companyId}\u0000${connection.channel}\u0000${asset}`;
}

function inboundActive(connection: InventoryConnectionInput): boolean {
  return connection.inbound?.enabled === true
    && connection.inbound.transport !== 'none'
    && connection.inbound.transport !== 'unknown';
}

function outboundActive(connection: InventoryConnectionInput): boolean {
  return connection.outbound?.enabled === true
    && connection.outbound.owner !== 'none'
    && connection.outbound.owner !== 'unknown';
}

/**
 * Validates a whole registry snapshot. Rows are checked for required fields; active
 * production rows sharing one asset are checked for duplicate senders and receivers.
 * Inactive rows and test-environment rows are ignored by cross-row conflict checks:
 * they describe history or a separate test asset, not a second production owner.
 */
export function validateInventory(connections: readonly InventoryConnectionInput[]): InventoryIssue[] {
  const issues: InventoryIssue[] = [];
  const aliases = new Map<string, InventoryConnectionInput[]>();
  const groups = new Map<string, InventoryConnectionInput[]>();

  for (const connection of connections) {
    const activeProduction = connection.active === true && connection.environment === 'production';
    const context = { activeProduction };

    requireText(issues, connection, 'companyId', connection.companyId, context);
    requireText(issues, connection, 'alias', connection.alias, context);
    if (!includes(INVENTORY_CHANNELS, connection.channel)) {
      addIssue(issues, connection, 'INVALID_FIELD_VALUE', 'error', 'channel', 'channel is not supported');
    }
    requireText(issues, connection, 'mode', connection.mode, context);
    if (!includes(INVENTORY_ENVIRONMENTS, connection.environment)) {
      addIssue(issues, connection, 'INVALID_FIELD_VALUE', 'error', 'environment', 'environment is not supported');
    }
    if (activeProduction) requireText(issues, connection, 'assetAlias', connection.assetAlias, context);
    requireText(issues, connection, 'owner', connection.owner, context);

    const inbound = connection.inbound;
    if (!inbound || typeof inbound !== 'object') {
      addIssue(issues, connection, 'MISSING_REQUIRED_FIELD', 'error', 'inbound', 'inbound is required');
    } else {
      if (!includes(INBOUND_TRANSPORTS, inbound.transport)) {
        addIssue(issues, connection, 'INVALID_FIELD_VALUE', 'error', 'inbound.transport', 'inbound transport is not supported');
      }
      if (inbound.enabled && (inbound.transport === 'none' || inbound.transport === 'unknown')) {
        addIssue(issues, connection, 'INVALID_FIELD_VALUE', 'error', 'inbound.transport',
          'an enabled inbound route needs a concrete transport');
      }
      if (activeProduction && inbound.enabled && !isKnown(inbound.subscriber)) {
        addIssue(issues, connection, 'INBOUND_SUBSCRIBER_REQUIRED', 'error', 'inbound.subscriber',
          'an enabled inbound route needs a named receiving system');
      }
    }

    const outbound = connection.outbound;
    if (!outbound || typeof outbound !== 'object') {
      addIssue(issues, connection, 'MISSING_REQUIRED_FIELD', 'error', 'outbound', 'outbound is required');
    } else {
      if (!includes(OUTBOUND_OWNERS, outbound.owner)) {
        addIssue(issues, connection, 'INVALID_FIELD_VALUE', 'error', 'outbound.owner', 'outbound owner is not supported');
      }
      if (activeProduction && outbound.enabled && (outbound.owner === 'none' || outbound.owner === 'unknown')) {
        addIssue(issues, connection, 'OUTBOUND_OWNER_REQUIRED', 'error', 'outbound.owner',
          'an enabled outbound route needs a concrete owner');
      }
    }

    const capabilities = connection.capabilities;
    if (!capabilities || typeof capabilities !== 'object') {
      addIssue(issues, connection, 'MISSING_REQUIRED_FIELD', activeProduction ? 'error' : 'warning',
        'capabilities', 'capabilities are required');
    } else {
      for (const key of CAPABILITY_KEYS) {
        if (typeof capabilities[key] !== 'boolean') {
          addIssue(issues, connection, 'INVALID_FIELD_VALUE', 'warning', `capabilities.${key}`,
            `capability ${key} must be a boolean`);
        }
      }
    }

    if (!includes(HISTORY_EXPORT_STATES, connection.historyExport)) {
      addIssue(issues, connection, 'INVALID_FIELD_VALUE', 'error', 'historyExport', 'history export state is not supported');
    }

    const alias = aliasOf(connection);
    if (alias) {
      const key = `${connection.companyId}\u0000${alias}`;
      const bucket = aliases.get(key) ?? [];
      bucket.push(connection);
      aliases.set(key, bucket);
    }

    if (activeProduction) {
      const key = assetKey(connection);
      if (key) {
        const bucket = groups.get(key) ?? [];
        bucket.push(connection);
        groups.set(key, bucket);
      }
    }
  }

  for (const bucket of aliases.values()) {
    if (bucket.length < 2) continue;
    for (const connection of bucket) {
      addIssue(issues, connection, 'DUPLICATE_ALIAS', 'error', 'alias',
        `alias ${text(connection.alias)} is used by ${bucket.length} registry rows`);
    }
  }

  for (const bucket of groups.values()) {
    const asset = text(bucket[0]?.assetAlias);

    const senders = bucket.filter(outboundActive);
    if (senders.length > 1) {
      const owners = senders.map((connection) => `${text(connection.alias)}:${connection.outbound.owner}`).join(', ');
      for (const connection of senders) {
        addIssue(issues, connection, 'DUPLICATE_OUTBOUND_OWNER', 'error', 'outbound.owner',
          `asset ${asset} has ${senders.length} active outbound senders (${owners})`, asset);
      }
    }

    const receivers = bucket.filter(inboundActive);
    if (receivers.length > 1) {
      const subscribers = receivers
        .map((connection) => `${text(connection.alias)}:${connection.inbound.transport}/${text(connection.inbound.subscriber)}`)
        .join(', ');
      for (const connection of receivers) {
        addIssue(issues, connection, 'CONFLICTING_INBOUND_SUBSCRIBER', 'error', 'inbound.subscriber',
          `asset ${asset} has ${receivers.length} active inbound receivers (${subscribers})`, asset);
      }

      const transports = new Set(receivers.map((connection) => connection.inbound.transport));
      const hasPush = transports.has('webhook') || transports.has('callback');
      const hasPull = transports.has('polling') || transports.has('long_poll');
      if (hasPush && hasPull) {
        for (const connection of receivers) {
          addIssue(issues, connection, 'WEBHOOK_POLLING_CONFLICT', 'error', 'inbound.transport',
            `asset ${asset} is subscribed both by a pushed route and by polling`, asset);
        }
      }
    }

    const projections = bucket.filter((connection) => connection.crmProjection?.enabled === true);
    if (projections.length > 1) {
      for (const connection of projections) {
        addIssue(issues, connection, 'DUPLICATE_CRM_PROJECTION_OWNER', 'error', 'crmProjection.owner',
          `asset ${asset} has ${projections.length} active CRM projection owners`, asset);
      }
    }
  }

  return issues;
}

export function hasInventoryErrors(issues: readonly InventoryIssue[]): boolean {
  return issues.some((issue) => issue.severity === 'error');
}

type InventoryRow = {
  company_id: string;
  alias: string;
  channel: string;
  mode: string;
  environment: string;
  active: boolean;
  asset_alias: string;
  owner: string;
  inbound_transport: string;
  inbound_subscriber: string | null;
  inbound_enabled: boolean;
  outbound_owner: string;
  outbound_enabled: boolean;
  crm_projection_owner: string | null;
  crm_projection_enabled: boolean;
  capabilities: unknown;
  history_export: string;
  notes: string | null;
  updated_at: Date;
};

function rowToConnection(row: InventoryRow): InventoryConnection {
  return {
    companyId: row.company_id,
    alias: row.alias,
    channel: row.channel as InventoryChannel,
    mode: row.mode,
    environment: row.environment as InventoryEnvironment,
    active: row.active,
    assetAlias: row.asset_alias,
    owner: row.owner,
    inbound: {
      transport: row.inbound_transport as InboundTransport,
      subscriber: row.inbound_subscriber,
      enabled: row.inbound_enabled,
    },
    outbound: {
      owner: row.outbound_owner as OutboundOwner,
      enabled: row.outbound_enabled,
    },
    crmProjection: {
      owner: row.crm_projection_owner,
      enabled: row.crm_projection_enabled,
    },
    capabilities: normalizeCapabilities(row.capabilities),
    historyExport: row.history_export as HistoryExportState,
    notes: row.notes,
    updatedAt: row.updated_at.toISOString(),
  };
}

function requireStorageText(value: unknown, field: string): string {
  const normalized = text(value);
  if (!normalized) throw new InventoryStorageError(`${field} is required`);
  return normalized;
}

const SELECT_COLUMNS = `company_id, alias, channel, mode, environment, active, asset_alias, owner,
  inbound_transport, inbound_subscriber, inbound_enabled, outbound_owner, outbound_enabled,
  crm_projection_owner, crm_projection_enabled, capabilities, history_export, notes, updated_at`;

/**
 * Inserts or updates one registry row. Storage stays permissive on purpose: an owner may
 * save a partially filled card with "UNKNOWN". Run validateStoredInventory before any
 * cutover decision; this function does not silently drop or rewrite unknown values.
 */
export async function saveInventoryConnection(
  db: Db | Tx,
  input: InventoryConnectionInput,
): Promise<InventoryConnection> {
  const companyId = requireStorageText(input.companyId, 'companyId');
  const alias = requireStorageText(input.alias, 'alias');
  if (!input.inbound || !input.outbound || !input.crmProjection) {
    throw new InventoryStorageError('inbound, outbound and crmProjection are required');
  }
  const capabilities = normalizeCapabilities(input.capabilities);

  const { rows } = await db.query<InventoryRow>(
    `INSERT INTO migration_inventory_connections
       (company_id, alias, channel, mode, environment, active, asset_alias, owner,
        inbound_transport, inbound_subscriber, inbound_enabled, outbound_owner, outbound_enabled,
        crm_projection_owner, crm_projection_enabled, capabilities, history_export, notes, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18,now())
     ON CONFLICT (company_id, alias) DO UPDATE SET
       channel = EXCLUDED.channel,
       mode = EXCLUDED.mode,
       environment = EXCLUDED.environment,
       active = EXCLUDED.active,
       asset_alias = EXCLUDED.asset_alias,
       owner = EXCLUDED.owner,
       inbound_transport = EXCLUDED.inbound_transport,
       inbound_subscriber = EXCLUDED.inbound_subscriber,
       inbound_enabled = EXCLUDED.inbound_enabled,
       outbound_owner = EXCLUDED.outbound_owner,
       outbound_enabled = EXCLUDED.outbound_enabled,
       crm_projection_owner = EXCLUDED.crm_projection_owner,
       crm_projection_enabled = EXCLUDED.crm_projection_enabled,
       capabilities = EXCLUDED.capabilities,
       history_export = EXCLUDED.history_export,
       notes = EXCLUDED.notes,
       updated_at = now()
     RETURNING ${SELECT_COLUMNS}`,
    [
      companyId,
      alias,
      input.channel,
      requireStorageText(input.mode, 'mode'),
      input.environment,
      input.active === true,
      requireStorageText(input.assetAlias, 'assetAlias'),
      requireStorageText(input.owner, 'owner'),
      input.inbound.transport,
      input.inbound.subscriber,
      input.inbound.enabled === true,
      input.outbound.owner,
      input.outbound.enabled === true,
      input.crmProjection.owner,
      input.crmProjection.enabled === true,
      JSON.stringify(capabilities),
      input.historyExport,
      input.notes ?? null,
    ],
  );
  return rowToConnection(rows[0]!);
}

export async function listInventoryConnections(db: Db | Tx, companyId: string): Promise<InventoryConnection[]> {
  const { rows } = await db.query<InventoryRow>(
    `SELECT ${SELECT_COLUMNS}
       FROM migration_inventory_connections
      WHERE company_id = $1
      ORDER BY alias`,
    [companyId],
  );
  return rows.map(rowToConnection);
}

/** Loads the persisted registry and applies the same rules as validateInventory. */
export async function validateStoredInventory(db: Db | Tx, companyId: string): Promise<InventoryIssue[]> {
  return validateInventory(await listInventoryConnections(db, companyId));
}
