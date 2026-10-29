import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildChannelCatalog,
  getCatalogEntry,
  registerChannelCatalogEntry,
  CHANNEL_CATALOG,
  CAPABILITY_FEATURES,
  type ChannelCatalogEntry,
} from '../src/channels/catalog.ts';

const CURRENT_MODES = [
  'telegram_bot',
  'telegram_personal',
  'telegram_business',
  'whatsapp_cloud',
  'whatsapp_qr',
  'max_bot',
  'vk_community',
] as const;

const PLANNED_IDS = [
  'viber_bot',
  'instagram_direct',
  'facebook_messenger',
  'line',
  'wechat',
  'signal_personal',
  'discord',
  'slack',
  'teams',
  'google_chat',
  'matrix',
  'xmpp',
  'mattermost',
  'rocket_chat',
  'zulip',
  'web_chat',
  'sms',
  'rcs',
  'email',
  'custom_provider',
] as const;

function findEntry(catalog: ReadonlyArray<ChannelCatalogEntry>, id: string): ChannelCatalogEntry {
  const entry = catalog.find((e) => e.id === id);
  assert.ok(entry, `expected catalog entry ${id}`);
  return entry;
}

function expectEntry(
  catalog: ReadonlyArray<ChannelCatalogEntry>,
  id: string,
  expected: Partial<ChannelCatalogEntry>,
): ChannelCatalogEntry {
  const entry = findEntry(catalog, id);
  assert.equal(entry.id, id);
  if (expected.name !== undefined) assert.equal(entry.name, expected.name);
  if (expected.family !== undefined) assert.equal(entry.family, expected.family);
  if (expected.connectionType !== undefined) assert.equal(entry.connectionType, expected.connectionType);
  if (expected.implementation !== undefined) assert.equal(entry.implementation, expected.implementation);
  assert.equal(entry.requiresSeparateCrmChannel, true);
  return entry;
}

test('catalog contains all current ChannelMode entries as adapter implementations', () => {
  const catalog = buildChannelCatalog();
  for (const id of CURRENT_MODES) {
    const entry = expectEntry(catalog, id, { implementation: 'adapter' });
    assert.equal(entry.id, id);
  }
});

test('catalog contains a broad planned provider list', () => {
  const catalog = buildChannelCatalog();
  for (const id of PLANNED_IDS) {
    const entry = expectEntry(catalog, id, { implementation: 'planned' });
    assert.equal(entry.id, id);
  }
});

test('current adapters keep stable names, families and connection types', () => {
  const catalog = buildChannelCatalog();
  expectEntry(catalog, 'telegram_bot', { name: 'Telegram Bot', family: 'telegram', connectionType: 'bot' });
  expectEntry(catalog, 'telegram_personal', { name: 'Telegram Personal', family: 'telegram', connectionType: 'personal' });
  expectEntry(catalog, 'telegram_business', { name: 'Telegram Business', family: 'telegram', connectionType: 'business' });
  expectEntry(catalog, 'whatsapp_cloud', { name: 'WhatsApp Cloud', family: 'whatsapp', connectionType: 'business' });
  expectEntry(catalog, 'whatsapp_qr', { name: 'WhatsApp QR', family: 'whatsapp', connectionType: 'business' });
  expectEntry(catalog, 'max_bot', { name: 'MAX Bot', family: 'max', connectionType: 'bot' });
  expectEntry(catalog, 'vk_community', { name: 'VK Community', family: 'vk', connectionType: 'community' });
});

test('planned providers cover requested brands with sensible connection types', () => {
  const catalog = buildChannelCatalog();
  expectEntry(catalog, 'viber_bot', { name: 'Viber Bot', family: 'viber', connectionType: 'bot' });
  expectEntry(catalog, 'instagram_direct', { name: 'Instagram Direct', family: 'instagram', connectionType: 'business' });
  expectEntry(catalog, 'facebook_messenger', { name: 'Facebook Messenger', family: 'facebook', connectionType: 'business' });
  expectEntry(catalog, 'line', { name: 'LINE', family: 'line', connectionType: 'bot' });
  expectEntry(catalog, 'wechat', { name: 'WeChat', family: 'wechat', connectionType: 'bot' });
  expectEntry(catalog, 'signal_personal', { name: 'Signal Personal', family: 'signal', connectionType: 'personal' });
  expectEntry(catalog, 'discord', { name: 'Discord', family: 'discord', connectionType: 'community' });
  expectEntry(catalog, 'slack', { name: 'Slack', family: 'slack', connectionType: 'workspace' });
  expectEntry(catalog, 'teams', { name: 'Microsoft Teams', family: 'teams', connectionType: 'workspace' });
  expectEntry(catalog, 'google_chat', { name: 'Google Chat', family: 'google_chat', connectionType: 'workspace' });
  expectEntry(catalog, 'matrix', { name: 'Matrix', family: 'matrix', connectionType: 'protocol' });
  expectEntry(catalog, 'xmpp', { name: 'XMPP', family: 'xmpp', connectionType: 'protocol' });
  expectEntry(catalog, 'mattermost', { name: 'Mattermost', family: 'mattermost', connectionType: 'workspace' });
  expectEntry(catalog, 'rocket_chat', { name: 'Rocket.Chat', family: 'rocket_chat', connectionType: 'workspace' });
  expectEntry(catalog, 'zulip', { name: 'Zulip', family: 'zulip', connectionType: 'workspace' });
  expectEntry(catalog, 'web_chat', { name: 'Web Chat', family: 'web_chat', connectionType: 'webhook' });
  expectEntry(catalog, 'sms', { name: 'SMS', family: 'sms', connectionType: 'protocol' });
  expectEntry(catalog, 'rcs', { name: 'RCS', family: 'rcs', connectionType: 'protocol' });
  expectEntry(catalog, 'email', { name: 'Email', family: 'email', connectionType: 'protocol' });
  expectEntry(catalog, 'custom_provider', { name: 'Custom Provider', family: 'custom', connectionType: 'webhook' });
});

test('every capability defaults to unknown for every provider', () => {
  const catalog = buildChannelCatalog();
  for (const entry of catalog) {
    for (const feature of CAPABILITY_FEATURES) {
      const directions = entry.capabilities[feature];
      assert.ok(directions, `${entry.id} is missing capability ${feature}`);
      assert.equal(directions.send, 'unknown', `${entry.id}.${feature}.send must default to unknown`);
      assert.equal(directions.receive, 'unknown', `${entry.id}.${feature}.receive must default to unknown`);
    }
  }
});

test('buildChannelCatalog returns independent copies', () => {
  const first = buildChannelCatalog();
  const second = buildChannelCatalog();

  assert.notStrictEqual(first, second);
  const firstTelegram = findEntry(first, 'telegram_bot');
  const secondTelegram = findEntry(second, 'telegram_bot');
  assert.notStrictEqual(firstTelegram, secondTelegram);
  assert.notStrictEqual(firstTelegram.capabilities, secondTelegram.capabilities);
  assert.notStrictEqual(firstTelegram.capabilities.text, secondTelegram.capabilities.text);

  // Mutating one catalog must not affect another.
  (firstTelegram.capabilities.text as { send: string }).send = 'supported';
  assert.equal(findEntry(second, 'telegram_bot').capabilities.text.send, 'unknown');

  // Reassigning an entry in one catalog must not affect another.
  const original = firstTelegram;
  const telegramIndex = first.findIndex((e) => e.id === 'telegram_bot');
  first[telegramIndex] = { ...original, name: 'Mutated' };
  assert.equal(findEntry(second, 'telegram_bot').name, original.name);
});

test('CHANNEL_CATALOG is immutable in practice', () => {
  assert.throws(() => {
    (CHANNEL_CATALOG as unknown as ChannelCatalogEntry[]).push({} as ChannelCatalogEntry);
  });
});

test('getCatalogEntry returns an independent entry by id', () => {
  const entry = getCatalogEntry('max_bot');
  assert.ok(entry);
  assert.equal(entry.id, 'max_bot');
  (entry.capabilities.text as { send: string }).send = 'supported' as never;
  const fresh = getCatalogEntry('max_bot');
  assert.equal(fresh?.capabilities.text.send, 'unknown');
});

test('getCatalogEntry returns undefined for unknown ids', () => {
  assert.equal(getCatalogEntry('not_a_provider'), undefined);
});

test('registerChannelCatalogEntry accepts unique snake_case ids', () => {
  const catalog = buildChannelCatalog();
  const result = registerChannelCatalogEntry(catalog, 'new_adapter');
  assert.equal(result.ok, true);
  assert.equal(result.ok === true && result.id, 'new_adapter');
});

test('registerChannelCatalogEntry rejects duplicate ids', () => {
  const catalog = buildChannelCatalog();
  const result = registerChannelCatalogEntry(catalog, 'telegram_bot');
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'duplicate_id');
});

test('registerChannelCatalogEntry rejects ids already in the static catalog', () => {
  const catalog = buildChannelCatalog();
  for (const id of CURRENT_MODES) {
    const result = registerChannelCatalogEntry(catalog, id);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'duplicate_id');
  }
});

test('registerChannelCatalogEntry rejects invalid ids', () => {
  const catalog = buildChannelCatalog();
  const invalidIds = ['', ' ', 'CamelCase', 'kebab-case', 'with space', 'UPPER_CASE', '1starts_with_number'];
  for (const id of invalidIds) {
    const result = registerChannelCatalogEntry(catalog, id);
    assert.equal(result.ok, false, `id ${JSON.stringify(id)} must be rejected`);
    assert.equal(result.ok === false && result.reason, 'invalid_id');
  }
});

test('registerChannelCatalogEntry does not enable or mutate the provider catalog', () => {
  const catalog = buildChannelCatalog();
  const beforeIds = catalog.map((e) => e.id).sort();
  registerChannelCatalogEntry(catalog, 'would_be_enabled');
  const afterIds = catalog.map((e) => e.id).sort();
  assert.deepEqual(afterIds, beforeIds);
});

test('catalog ids are stable snake_case strings', () => {
  const catalog = buildChannelCatalog();
  const snakeCaseRe = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
  for (const entry of catalog) {
    assert.match(entry.id, snakeCaseRe, `${entry.id} must be snake_case`);
    assert.equal(entry.id, entry.id);
  }
});
