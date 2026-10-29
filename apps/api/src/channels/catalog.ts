/**
 * Provider catalog preparation.
 *
 * This module is intentionally free of network calls, credentials and runtime
 * state. It describes what channels the system knows about and what has been
 * proven end-to-end by an adapter. Any capability that is not confirmed by the
 * runtime binding is reported as `unknown`; vendor documentation or mode names
 * are never enough to mark a feature `supported`.
 */

export type CapabilityState = 'supported' | 'unsupported' | 'unknown';

export const CAPABILITY_FEATURES = [
  'text',
  'photo',
  'document',
  'video',
  'audio',
  'voice',
  'animation',
  'sticker',
  'videoNote',
  'contact',
  'location',
  'poll',
  'buttons',
  'reply',
  'forward',
  'reaction',
  'edit',
  'delete',
  'typing',
  'delivery',
  'read',
  'history',
  'groups',
  'topics',
  'audioCall',
  'videoCall',
] as const;

export type CapabilityFeature = (typeof CAPABILITY_FEATURES)[number];

export type CapabilityDirection = 'send' | 'receive';

export type FeatureCapabilities = Record<CapabilityDirection, CapabilityState>;

export type ChannelCapabilities = Record<CapabilityFeature, FeatureCapabilities>;

export type ConnectionType =
  | 'bot'
  | 'business'
  | 'personal'
  | 'community'
  | 'workspace'
  | 'webhook'
  | 'protocol';

export type ImplementationStatus = 'adapter' | 'planned';

export type ChannelFamily =
  | 'telegram'
  | 'whatsapp'
  | 'max'
  | 'vk'
  | 'viber'
  | 'instagram'
  | 'facebook'
  | 'line'
  | 'wechat'
  | 'signal'
  | 'discord'
  | 'slack'
  | 'teams'
  | 'google_chat'
  | 'matrix'
  | 'xmpp'
  | 'mattermost'
  | 'rocket_chat'
  | 'zulip'
  | 'web_chat'
  | 'sms'
  | 'rcs'
  | 'email'
  | 'custom';

export interface ChannelCatalogEntry {
  /** Stable snake_case identifier used in code and storage. */
  readonly id: string;
  /** Human-readable provider name. */
  readonly name: string;
  readonly family: ChannelFamily;
  readonly connectionType: ConnectionType;
  /** `adapter` when a runtime adapter exists; `planned` otherwise. */
  readonly implementation: ImplementationStatus;
  /** Every provider needs its own CRM channel record. */
  readonly requiresSeparateCrmChannel: true;
  /** Per-feature send/receive capability states. */
  readonly capabilities: ChannelCapabilities;
}

export type ChannelCatalog = ReadonlyArray<ChannelCatalogEntry>;

function unknownCapabilities(): ChannelCapabilities {
  const directions: FeatureCapabilities = { send: 'unknown', receive: 'unknown' };
  const result = {} as Record<CapabilityFeature, FeatureCapabilities>;
  for (const feature of CAPABILITY_FEATURES) {
    result[feature] = { ...directions };
  }
  return result;
}

const SNAKE_CASE_RE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

function entry(
  id: string,
  name: string,
  family: ChannelFamily,
  connectionType: ConnectionType,
  implementation: ImplementationStatus,
): ChannelCatalogEntry {
  return {
    id,
    name,
    family,
    connectionType,
    implementation,
    requiresSeparateCrmChannel: true,
    capabilities: unknownCapabilities(),
  };
}

export const CHANNEL_CATALOG: ChannelCatalog = Object.freeze([
  // Current seven ChannelMode values.
  entry('telegram_bot', 'Telegram Bot', 'telegram', 'bot', 'adapter'),
  entry('telegram_personal', 'Telegram Personal', 'telegram', 'personal', 'adapter'),
  entry('telegram_business', 'Telegram Business', 'telegram', 'business', 'adapter'),
  entry('whatsapp_cloud', 'WhatsApp Cloud', 'whatsapp', 'business', 'adapter'),
  entry('whatsapp_qr', 'WhatsApp QR', 'whatsapp', 'business', 'adapter'),
  entry('max_bot', 'MAX Bot', 'max', 'bot', 'adapter'),
  entry('vk_community', 'VK Community', 'vk', 'community', 'adapter'),

  // Planned providers.
  entry('viber_bot', 'Viber Bot', 'viber', 'bot', 'planned'),
  entry('instagram_direct', 'Instagram Direct', 'instagram', 'business', 'planned'),
  entry('facebook_messenger', 'Facebook Messenger', 'facebook', 'business', 'planned'),
  entry('line', 'LINE', 'line', 'bot', 'planned'),
  entry('wechat', 'WeChat', 'wechat', 'bot', 'planned'),
  entry('signal_personal', 'Signal Personal', 'signal', 'personal', 'planned'),
  entry('discord', 'Discord', 'discord', 'community', 'planned'),
  entry('slack', 'Slack', 'slack', 'workspace', 'planned'),
  entry('teams', 'Microsoft Teams', 'teams', 'workspace', 'planned'),
  entry('google_chat', 'Google Chat', 'google_chat', 'workspace', 'planned'),
  entry('matrix', 'Matrix', 'matrix', 'protocol', 'planned'),
  entry('xmpp', 'XMPP', 'xmpp', 'protocol', 'planned'),
  entry('mattermost', 'Mattermost', 'mattermost', 'workspace', 'planned'),
  entry('rocket_chat', 'Rocket.Chat', 'rocket_chat', 'workspace', 'planned'),
  entry('zulip', 'Zulip', 'zulip', 'workspace', 'planned'),
  entry('web_chat', 'Web Chat', 'web_chat', 'webhook', 'planned'),
  entry('sms', 'SMS', 'sms', 'protocol', 'planned'),
  entry('rcs', 'RCS', 'rcs', 'protocol', 'planned'),
  entry('email', 'Email', 'email', 'protocol', 'planned'),
  entry('custom_provider', 'Custom Provider', 'custom', 'webhook', 'planned'),
]);

function cloneCapabilities(capabilities: ChannelCapabilities): ChannelCapabilities {
  const copy = {} as Record<CapabilityFeature, FeatureCapabilities>;
  for (const feature of CAPABILITY_FEATURES) {
    const directions = capabilities[feature];
    copy[feature] = { send: directions.send, receive: directions.receive };
  }
  return copy;
}

/** Returns an independent deep-copy array of the static catalog. */
export function buildChannelCatalog(): ChannelCatalogEntry[] {
  return CHANNEL_CATALOG.map((entry) => ({
    ...entry,
    capabilities: cloneCapabilities(entry.capabilities),
  }));
}

/** Look up a catalog entry by its stable snake_case id. */
export function getCatalogEntry(id: string): ChannelCatalogEntry | undefined {
  return buildChannelCatalog().find((entry) => entry.id === id);
}

/** Validation result for catalog extensions. */
export type CatalogExtensionResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'duplicate_id' | 'invalid_id' | 'missing_id' };

/**
 * Registers a new catalog entry without enabling the provider.
 *
 * The function only validates that the id is unique, non-empty and snake_case.
 * It does not create connections, workers or credentials. Returns a result that
 * callers can use to decide whether to proceed with activation.
 */
export function registerChannelCatalogEntry(
  catalog: ReadonlyArray<ChannelCatalogEntry>,
  id: string,
): CatalogExtensionResult {
  if (typeof id !== 'string') {
    return { ok: false, reason: 'missing_id' };
  }
  if (id.length === 0 || !SNAKE_CASE_RE.test(id)) {
    return { ok: false, reason: 'invalid_id' };
  }
  if (catalog.some((entry) => entry.id === id)) {
    return { ok: false, reason: 'duplicate_id' };
  }
  return { ok: true, id };
}
