import { withTransaction, type Db } from '../platform/db.ts';
import { insertTelegramUpdate, readTelegramCheckpoint, type TelegramScope } from './inbox.ts';

export type PollLease = {
  owner: string;
  fence: number;
  until: string;
};

export class LeaseLostError extends Error {
  readonly code = 'lease_lost';
  constructor() {
    super('lease_lost');
  }
}

export type PollCommitResult = {
  stored: number;
  duplicates: number;
  checkpoint: number;
};

/**
 * Acquires the single poller lease for a connection. The lease lives in the
 * connection's health document so no extra relation is required; the fence is
 * monotonic and is rechecked inside the commit transaction.
 */
export async function acquirePollLease(
  db: Db,
  scope: TelegramScope,
  options: { owner: string; ttlMs: number },
): Promise<PollLease | null> {
  const { rows } = await db.query<{ fence: string; until: string }>(
    `UPDATE connections c
        SET health = jsonb_set(
              c.health,
              '{telegram_poll}',
              jsonb_build_object(
                'owner', $3::text,
                'fence', COALESCE((c.health->'telegram_poll'->>'fence')::bigint, 0) + 1,
                'until', (now() + ($4::text || ' milliseconds')::interval)::text
              ),
              true)
      WHERE c.company_id = $1 AND c.id = $2
        AND (c.health->'telegram_poll'->>'until' IS NULL
             OR (c.health->'telegram_poll'->>'until')::timestamptz <= now())
      RETURNING (c.health->'telegram_poll'->>'fence')::bigint AS fence,
                c.health->'telegram_poll'->>'until' AS until`,
    [scope.companyId, scope.connectionId, options.owner, String(options.ttlMs)],
  );
  const acquired = rows[0];
  if (!acquired) return null;
  return { owner: options.owner, fence: Number(acquired.fence), until: acquired.until };
}

/**
 * Commits a fetched poll batch. The lease fence is verified in the same
 * transaction that writes the inbox, so a superseded poller can never advance
 * the checkpoint.
 */
export async function commitPollBatch(
  db: Db,
  scope: TelegramScope,
  lease: PollLease,
  updates: Record<string, unknown>[],
): Promise<PollCommitResult> {
  return withTransaction(db, async (tx) => {
    const { rows } = await tx.query<{ owner: string | null; fence: string | null; valid: boolean }>(
      `SELECT health->'telegram_poll'->>'owner' AS owner,
              health->'telegram_poll'->>'fence' AS fence,
              COALESCE((health->'telegram_poll'->>'until')::timestamptz > now(), false) AS valid
         FROM connections
        WHERE company_id = $1 AND id = $2
        FOR UPDATE`,
      [scope.companyId, scope.connectionId],
    );
    const current = rows[0];
    if (
      !current ||
      current.owner !== lease.owner ||
      Number(current.fence) !== lease.fence ||
      current.valid !== true
    ) {
      throw new LeaseLostError();
    }

    let stored = 0;
    let duplicates = 0;
    for (const update of updates) {
      const outcome = await insertTelegramUpdate(tx, scope, update);
      if (outcome.duplicate) duplicates += 1;
      else stored += 1;
    }
    const checkpoint = await readTelegramCheckpoint(tx, scope);
    return { stored, duplicates, checkpoint };
  });
}
