// Pure routing decisions: which number reaches the contact search, and which of the
// contact's open deals the message lands in. Kept apart from the database tests so
// the rules themselves stay cheap to check.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRuPhone, pickNewestLead } from '../src/integrations/amocrm/sync.ts';

test('a Russian number written with 8 becomes the same +7 number', () => {
  assert.equal(normalizeRuPhone('89991234567'), '+79991234567');
  assert.equal(normalizeRuPhone('8 999 123-45-67'), '+79991234567');
  assert.equal(normalizeRuPhone('+7 (999) 123-45-67'), '+79991234567');
  assert.equal(normalizeRuPhone('79991234567'), '+79991234567');
});

test('the same number in both spellings collapses to one value', () => {
  assert.equal(normalizeRuPhone('89991234567'), normalizeRuPhone('+79991234567'));
});

test('anything that is not a plain Russian number is left alone', () => {
  for (const value of ['+442071838750', '12345', 'anna@example.com', '+7 999']) {
    assert.equal(normalizeRuPhone(value), value, `value ${JSON.stringify(value)}`);
  }
  assert.equal(normalizeRuPhone(null), null);
  assert.equal(normalizeRuPhone(undefined), null);
  assert.equal(normalizeRuPhone('   '), null);
});

test('the most recently updated open deal wins', () => {
  const chosen = pickNewestLead([
    { id: '11', updatedAt: '2026-01-01T00:00:00.000Z' },
    { id: '22', updatedAt: '2026-10-01T00:00:00.000Z' },
    { id: '33', updatedAt: '2026-05-01T00:00:00.000Z' },
  ]);
  assert.equal(chosen, '22');
});

test('a tie is broken by id so two retries agree on the same deal', () => {
  const tied = [
    { id: '77', updatedAt: '2026-10-01T00:00:00.000Z' },
    { id: '12', updatedAt: '2026-10-01T00:00:00.000Z' },
  ];
  assert.equal(pickNewestLead(tied), pickNewestLead([...tied].reverse()));
  assert.equal(pickNewestLead(tied), '12');
});

test('a lead with no known update time never beats one that has it', () => {
  const chosen = pickNewestLead([
    { id: '11', updatedAt: null },
    { id: '22', updatedAt: '2026-01-01T00:00:00.000Z' },
  ]);
  assert.equal(chosen, '22');
});

test('no open deals means a new one is needed', () => {
  assert.equal(pickNewestLead([]), null);
});
