// Pure attention rules. No SQL, no I/O: the repository persists these decisions.

export type ObligationState = 'open' | 'covered' | 'cancelled';

export type ObligationRef = { obligationId: string; contentVersion: number };

export type ObligationView = ObligationRef & {
  messageId: string;
  state: ObligationState;
  attentionSeq: number;
  openedAt: Date | string;
  /** True when a newer content version replaced this obligation. */
  superseded?: boolean;
};

/** Content keys that describe transport/metadata, not what the customer asked. */
export const TECHNICAL_CONTENT_KEYS: ReadonlySet<string> = new Set([
  'edited_at',
  'editedAt',
  'updated_at',
  'updatedAt',
  'metadata',
  'reactions',
  'views',
  'seen_at',
  'seenAt',
  'read_at',
  'readAt',
  'delivered_at',
  'deliveredAt',
]);

function stripTechnical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripTechnical);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    if (TECHNICAL_CONTENT_KEYS.has(key)) continue;
    out[key] = stripTechnical((value as Record<string, unknown>)[key]);
  }
  return out;
}

/**
 * A substantial edit changes what the customer actually asked. Pure metadata
 * (edit timestamp, reactions, read markers) never opens a new waiting cycle.
 * Any content change is treated as substantial for MVP: the rule is versioned and
 * a repeated identical version creates nothing.
 */
export function isSubstantialEdit(previous: unknown, next: unknown): boolean {
  return JSON.stringify(stripTechnical(previous)) !== JSON.stringify(stripTechnical(next));
}

/**
 * Coverage is exactly the snapshot items whose content version is still the live one.
 * A new inbound is a different obligation and stays open; a superseded or cancelled
 * version is not covered. Two answers composed from the same snapshot may both cover
 * the same obligation: coverage is additive, so an already covered item still counts.
 */
export function planCoverage(
  snapshotItems: readonly ObligationRef[],
  obligations: readonly ObligationView[],
): ObligationRef[] {
  const current = new Map(obligations.map((item) => [item.obligationId, item]));
  const seen = new Set<string>();
  const planned: ObligationRef[] = [];
  for (const item of snapshotItems) {
    const live = current.get(item.obligationId);
    if (!live || live.state === 'cancelled' || live.superseded) continue;
    if (live.contentVersion !== item.contentVersion) continue;
    const key = `${item.obligationId}:${item.contentVersion}`;
    if (seen.has(key)) continue;
    seen.add(key);
    planned.push({ obligationId: item.obligationId, contentVersion: item.contentVersion });
  }
  return planned;
}

/** Multiple answers may cover the same obligation; coverage is a union, never a replacement. */
export function mergeCoverage(
  existing: readonly ObligationRef[],
  incoming: readonly ObligationRef[],
): ObligationRef[] {
  const merged = new Map<string, ObligationRef>();
  for (const item of [...existing, ...incoming]) {
    merged.set(`${item.obligationId}:${item.contentVersion}`, item);
  }
  return [...merged.values()];
}

/** Waiting starts at the earliest still-open obligation. Reading does not move it. */
export function waitingSince(obligations: readonly { state: ObligationState; openedAt: Date | string }[]): Date | null {
  let earliest: Date | null = null;
  for (const item of obligations) {
    if (item.state !== 'open') continue;
    const at = item.openedAt instanceof Date ? item.openedAt : new Date(item.openedAt);
    if (Number.isNaN(at.getTime())) continue;
    if (!earliest || at.getTime() < earliest.getTime()) earliest = at;
  }
  return earliest;
}

/**
 * A substantial edit of an open obligation keeps the original waiting start, so an
 * already overdue question does not become fresh. Editing something that was already
 * answered starts a new cycle at `now`.
 */
export function inheritOpenedAt(previous: { state: ObligationState; openedAt: Date | string }, now: Date): Date {
  if (previous.state !== 'open') return now;
  return previous.openedAt instanceof Date ? previous.openedAt : new Date(previous.openedAt);
}

/** Only a confirmed provider success closes obligations. Everything else keeps them open. */
export function isCoverageClosingOutcome(state: string): boolean {
  return state === 'sent';
}
