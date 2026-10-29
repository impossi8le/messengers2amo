import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './helpers/db.ts';
import {
  listInventoryConnections,
  saveInventoryConnection,
  validateInventory,
  validateStoredInventory,
  type InventoryConnectionInput,
} from '../src/migration/inventory.ts';

function connection(overrides: Partial<InventoryConnectionInput> = {}): InventoryConnectionInput {
  return {
    companyId: 'c1',
    alias: 'WA-PROD-01',
    channel: 'whatsapp',
    mode: 'whatsapp_cloud',
    environment: 'production',
    active: true,
    assetAlias: 'asset-wa-01',
    owner: 'owner-alice',
    inbound: { transport: 'webhook', subscriber: 'wazzup', enabled: true },
    outbound: { owner: 'wazzup', enabled: true },
    crmProjection: { owner: 'wazzup', enabled: true },
    capabilities: { groups: false, files: true, templates: true, outboundInitiated: false },
    historyExport: 'partial',
    ...overrides,
  };
}

test('inventory validation reports a production connection without an accountable owner', () => {
  const issues = validateInventory([
    connection({ alias: 'WA-PROD-01', owner: 'UNKNOWN' }),
    connection({ alias: 'TG-PROD-01', channel: 'telegram', mode: 'telegram_bot', assetAlias: 'asset-tg-01', owner: '' }),
  ]);

  const ownerIssues = issues.filter((issue) => issue.field === 'owner' && issue.severity === 'error');
  assert.equal(ownerIssues.length, 2, JSON.stringify(issues));
  assert.ok(ownerIssues.some((issue) => issue.code === 'UNKNOWN_REQUIRED_FIELD' && issue.alias === 'WA-PROD-01'));
  assert.ok(ownerIssues.some((issue) => issue.code === 'MISSING_REQUIRED_FIELD' && issue.alias === 'TG-PROD-01'));
});

test('inventory validation rejects two active outbound owners on one asset', () => {
  const issues = validateInventory([
    connection({ alias: 'WA-PROD-01', outbound: { owner: 'wazzup', enabled: true } }),
    connection({
      alias: 'WA-NEW-01',
      mode: 'whatsapp_cloud',
      outbound: { owner: 'new_contour', enabled: true },
      inbound: { transport: 'none', subscriber: null, enabled: false },
    }),
  ]);

  const conflicts = issues.filter((issue) => issue.code === 'DUPLICATE_OUTBOUND_OWNER');
  assert.equal(conflicts.length, 2, JSON.stringify(issues));
  assert.ok(conflicts.every((issue) => issue.severity === 'error' && issue.assetAlias === 'asset-wa-01'));
  assert.ok(conflicts.some((issue) => issue.alias === 'WA-PROD-01'));
  assert.ok(conflicts.some((issue) => issue.alias === 'WA-NEW-01'));
});

test('inventory validation rejects conflicting webhook and polling subscribers on one asset', () => {
  const issues = validateInventory([
    connection({ alias: 'TG-PROD-01', channel: 'telegram', mode: 'telegram_bot', assetAlias: 'asset-tg-01',
      inbound: { transport: 'webhook', subscriber: 'wazzup', enabled: true },
      outbound: { owner: 'wazzup', enabled: true } }),
    connection({ alias: 'TG-SHADOW-01', channel: 'telegram', mode: 'telegram_bot', assetAlias: 'asset-tg-01',
      inbound: { transport: 'polling', subscriber: 'new_contour', enabled: true },
      outbound: { owner: 'none', enabled: false } }),
  ]);

  const conflicts = issues.filter((issue) => issue.code === 'CONFLICTING_INBOUND_SUBSCRIBER');
  assert.equal(conflicts.length, 2, JSON.stringify(issues));
  assert.ok(conflicts.every((issue) => issue.severity === 'error' && issue.assetAlias === 'asset-tg-01'));
  assert.ok(issues.some((issue) => issue.code === 'WEBHOOK_POLLING_CONFLICT' && issue.assetAlias === 'asset-tg-01'));
});

test('inventory validation accepts one active production owner per asset and ignores test or inactive rows', () => {
  const issues = validateInventory([
    connection({ alias: 'WA-PROD-01' }),
    connection({
      alias: 'WA-TEST-01',
      environment: 'test',
      assetAlias: 'asset-wa-01',
      owner: 'owner-bob',
      inbound: { transport: 'polling', subscriber: 'new_contour', enabled: true },
      outbound: { owner: 'new_contour', enabled: true },
    }),
    connection({
      alias: 'TG-PROD-01',
      channel: 'telegram',
      mode: 'telegram_bot',
      assetAlias: 'asset-tg-01',
      inbound: { transport: 'webhook', subscriber: 'wazzup', enabled: true },
      outbound: { owner: 'wazzup', enabled: true },
    }),
    connection({
      alias: 'TG-RETIRED-01',
      channel: 'telegram',
      mode: 'telegram_bot',
      assetAlias: 'asset-tg-01',
      active: false,
      inbound: { transport: 'polling', subscriber: 'old_contour', enabled: true },
      outbound: { owner: 'new_contour', enabled: true },
    }),
  ]);

  assert.deepEqual(issues.filter((issue) => issue.severity === 'error'), []);
});

test('stored inventory validation catches dangerous configuration in PostgreSQL', async () => {
  const { db, close } = await createTestDb();
  try {
    await db.query('INSERT INTO companies (id) VALUES ($1)', ['c1']);

    await saveInventoryConnection(db, connection({ alias: 'WA-PROD-01', owner: 'UNKNOWN' }));

    await saveInventoryConnection(db, connection({
      alias: 'WA-PROD-02',
      owner: 'owner-alice',
      outbound: { owner: 'wazzup', enabled: true },
    }));
    await saveInventoryConnection(db, connection({
      alias: 'WA-NEW-02',
      owner: 'owner-bob',
      inbound: { transport: 'none', subscriber: null, enabled: false },
      outbound: { owner: 'new_contour', enabled: true },
    }));

    await saveInventoryConnection(db, connection({
      alias: 'TG-PROD-01',
      channel: 'telegram',
      mode: 'telegram_bot',
      assetAlias: 'asset-tg-01',
      inbound: { transport: 'webhook', subscriber: 'wazzup', enabled: true },
      outbound: { owner: 'wazzup', enabled: true },
    }));
    await saveInventoryConnection(db, connection({
      alias: 'TG-SHADOW-01',
      channel: 'telegram',
      mode: 'telegram_bot',
      assetAlias: 'asset-tg-01',
      inbound: { transport: 'polling', subscriber: 'new_contour', enabled: true },
      outbound: { owner: 'none', enabled: false },
    }));

    const issues = await validateStoredInventory(db, 'c1');
    const codes = new Set(issues.map((issue) => issue.code));
    assert.ok(codes.has('UNKNOWN_REQUIRED_FIELD'), JSON.stringify(issues));
    assert.ok(codes.has('DUPLICATE_OUTBOUND_OWNER'), JSON.stringify(issues));
    assert.ok(codes.has('CONFLICTING_INBOUND_SUBSCRIBER'), JSON.stringify(issues));
    assert.ok(codes.has('WEBHOOK_POLLING_CONFLICT'), JSON.stringify(issues));
  } finally {
    await close();
  }
});

test('a correct stored inventory round-trips and passes validation in PostgreSQL', async () => {
  const { db, close } = await createTestDb();
  try {
    await db.query('INSERT INTO companies (id) VALUES ($1)', ['c1']);

    const saved = await saveInventoryConnection(db, connection({ alias: 'WA-PROD-01' }));
    assert.equal(saved.alias, 'WA-PROD-01');
    assert.equal(saved.owner, 'owner-alice');
    assert.equal(saved.capabilities.files, true);
    assert.equal(saved.capabilities.templates, true);

    await saveInventoryConnection(db, connection({
      alias: 'TG-PROD-01',
      channel: 'telegram',
      mode: 'telegram_bot',
      assetAlias: 'asset-tg-01',
      inbound: { transport: 'webhook', subscriber: 'wazzup', enabled: true },
      outbound: { owner: 'wazzup', enabled: true },
    }));

    const rows = await listInventoryConnections(db, 'c1');
    assert.deepEqual(rows.map((row) => row.alias), ['TG-PROD-01', 'WA-PROD-01']);
    assert.deepEqual(await validateStoredInventory(db, 'c1'), []);
  } finally {
    await close();
  }
});
