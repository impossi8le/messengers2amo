// Workshop (business unit) and connection-routing domain.
//
// A workshop is a place of service/accounting; a department is a queue/function of
// staff. They are separate identities and are never derived from each other, and no
// display name is ever used as a key. A connection belongs to exactly one workshop
// through `connection_routes`, and every route carries the CRM account, funnel,
// default owner and technical source used for projections from that connection.

import type { Db, Tx } from '../platform/db.ts';
import { withTransaction } from '../platform/db.ts';
import { qualified } from '../integrations/amocrm/store.ts';
import { GroupPolicyService } from './groups.ts';

export type Workshop = { companyId: string; id: string; displayName: string | null };

export type WorkshopStaff = { companyId: string; workshopId: string; staffId: string };

export type ConnectionRoute = {
  companyId: string;
  connectionId: string;
  workshopId: string;
  crmAccountId: string;
  funnelId: string;
  defaultOwnerId: string;
  technicalSourceId: string;
  /** Stage inside the funnel new leads start on; null means the account default. */
  statusId: string | null;
  /** Who is told when the channel breaks; null means nobody. */
  alertStaffId: string | null;
  /** Match a Russian number typed as 8XXXXXXXXXX against +7XXXXXXXXXX. */
  normalizePhone: boolean;
  version: number;
};

export type ChatKind = 'private' | 'group' | 'unknown';

export type InboundResolution = {
  workshopId: string;
  crmAccountId: string;
  funnelId: string;
  defaultOwnerId: string;
  technicalSourceId: string;
  routeVersion: number;
  crmImportAllowed: boolean;
  chatDecision: { allowed: boolean; reason: string };
};

export type MarketingOrigin = { originCode: string; sourceRef: string | null };

export type TechnicalSource = { id: string; externalId: string; originCode: string; sourceKind: string };

export type AccessDecision = { allowed: boolean; reason: string };

export type WorkshopServiceDeps = { db: Db; schema?: string };

/** A route change carried a stale `expectedVersion`; the current version is returned. */
export class WorkshopConflictError extends Error {
  readonly currentVersion: number;

  constructor(currentVersion: number) {
    super('VERSION_CONFLICT');
    this.name = 'WorkshopConflictError';
    this.currentVersion = currentVersion;
  }
}

type WorkshopRow = { company_id: string; id: string; display_name: string | null };

type RouteRow = {
  company_id: string;
  connection_id: string;
  workshop_id: string;
  crm_account_id: string;
  funnel_id: string;
  default_owner_id: string;
  technical_source_id: string;
  status_id: string | null;
  alert_staff_id: string | null;
  normalize_phone: boolean;
  version: string | number;
};

type PolicyRow = {
  crm_projection_enabled: boolean;
  private_import_enabled: boolean;
};

type RuleRow = { decision: 'allow_crm' | 'exclude' | 'archive_only'; version: string | number };

function toWorkshop(row: WorkshopRow): Workshop {
  return { companyId: row.company_id, id: row.id, displayName: row.display_name };
}

function toRoute(row: RouteRow): ConnectionRoute {
  return {
    companyId: row.company_id,
    connectionId: row.connection_id,
    workshopId: row.workshop_id,
    crmAccountId: row.crm_account_id,
    funnelId: row.funnel_id,
    defaultOwnerId: row.default_owner_id,
    technicalSourceId: row.technical_source_id,
    statusId: row.status_id,
    alertStaffId: row.alert_staff_id,
    normalizePhone: row.normalize_phone,
    version: Number(row.version),
  };
}

export class WorkshopService {
  private readonly db: Db;
  private readonly schema: string | undefined;
  private readonly groups: GroupPolicyService;

  constructor(deps: WorkshopServiceDeps) {
    this.db = deps.db;
    this.schema = deps.schema;
    this.groups = new GroupPolicyService({ db: deps.db, schema: deps.schema });
  }

  private q(name: string): string {
    return qualified(this.schema, name);
  }

  // --- workshops (business units) -------------------------------------------------

  async createWorkshop(input: {
    companyId: string;
    id: string;
    displayName?: string | null;
  }): Promise<Workshop> {
    return this.createWorkshopInTransaction(this.db, input);
  }

  /** Same upsert on the caller's transaction, so audit and mutation commit together. */
  async createWorkshopInTransaction(
    tx: Db | Tx,
    input: { companyId: string; id: string; displayName?: string | null },
  ): Promise<Workshop> {
    const { rows } = await tx.query<WorkshopRow>(
      `INSERT INTO ${this.q('workshops')}(company_id,id,display_name)
       VALUES ($1,$2,$3)
       ON CONFLICT (company_id,id) DO UPDATE SET display_name=EXCLUDED.display_name
       RETURNING company_id, id, display_name`,
      [input.companyId, input.id, input.displayName ?? null],
    );
    const created = rows[0];
    if (!created) throw new Error('WORKSHOP_UPSERT_FAILED');
    return toWorkshop(created);
  }

  async getWorkshop(companyId: string, workshopId: string): Promise<Workshop | null> {
    const { rows } = await this.db.query<WorkshopRow>(
      `SELECT company_id, id, display_name FROM ${this.q('workshops')} WHERE company_id=$1 AND id=$2`,
      [companyId, workshopId],
    );
    return rows[0] ? toWorkshop(rows[0]) : null;
  }

  async listWorkshops(companyId: string): Promise<Workshop[]> {
    const { rows } = await this.db.query<WorkshopRow>(
      `SELECT company_id, id, display_name FROM ${this.q('workshops')}
        WHERE company_id=$1 ORDER BY id`,
      [companyId],
    );
    return rows.map(toWorkshop);
  }

  async deleteWorkshop(companyId: string, workshopId: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `DELETE FROM ${this.q('workshops')} WHERE company_id=$1 AND id=$2`,
      [companyId, workshopId],
    );
    return (rowCount ?? 0) > 0;
  }

  // --- staff membership (explicit, many workshops per staff member) ---------------

  async assignStaff(input: { companyId: string; workshopId: string; staffId: string }): Promise<void> {
    await this.db.query(
      `INSERT INTO ${this.q('workshop_staff')}(company_id,workshop_id,staff_id)
       VALUES ($1,$2,$3)
       ON CONFLICT (company_id,workshop_id,staff_id) DO NOTHING`,
      [input.companyId, input.workshopId, input.staffId],
    );
  }

  async unassignStaff(input: { companyId: string; workshopId: string; staffId: string }): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `DELETE FROM ${this.q('workshop_staff')}
        WHERE company_id=$1 AND workshop_id=$2 AND staff_id=$3`,
      [input.companyId, input.workshopId, input.staffId],
    );
    return (rowCount ?? 0) > 0;
  }

  async listWorkshopStaff(companyId: string, workshopId: string): Promise<WorkshopStaff[]> {
    const { rows } = await this.db.query<{ company_id: string; workshop_id: string; staff_id: string }>(
      `SELECT company_id, workshop_id, staff_id FROM ${this.q('workshop_staff')}
        WHERE company_id=$1 AND workshop_id=$2 ORDER BY staff_id`,
      [companyId, workshopId],
    );
    return rows.map((row) => ({
      companyId: row.company_id,
      workshopId: row.workshop_id,
      staffId: row.staff_id,
    }));
  }

  /** Workshops a staff member explicitly works in. Never inferred from departments. */
  async listStaffWorkshops(companyId: string, staffId: string): Promise<string[]> {
    const { rows } = await this.db.query<{ workshop_id: string }>(
      `SELECT workshop_id FROM ${this.q('workshop_staff')}
        WHERE company_id=$1 AND staff_id=$2 ORDER BY workshop_id`,
      [companyId, staffId],
    );
    return rows.map((row) => row.workshop_id);
  }

  // --- connection routes ----------------------------------------------------------

  /**
   * Creates or replaces the route of one connection. The route is versioned: every
   * accepted change increments `version`, so a projection can record which routing
   * configuration it used. A connection has at most one workshop route.
   */
  async setConnectionRoute(
    input: Omit<ConnectionRoute, 'version' | 'statusId' | 'alertStaffId' | 'normalizePhone'> & {
      /** Routing settings are optional: a caller that omits them gets the defaults. */
      statusId?: string | null;
      alertStaffId?: string | null;
      normalizePhone?: boolean;
    },
  ): Promise<ConnectionRoute> {
    return withTransaction(this.db, async (tx) => this.setConnectionRouteInTransaction(tx, input));
  }

  /**
   * Creates or replaces the route on the caller's transaction. When `expectedVersion`
   * is supplied the write is compare-and-set: a stale version throws
   * `WorkshopConflictError` carrying the version currently stored.
   */
  async setConnectionRouteInTransaction(
    tx: Tx,
    input: Omit<ConnectionRoute, 'version' | 'statusId' | 'alertStaffId' | 'normalizePhone'> & {
      /** Routing settings are optional: a caller that omits them gets the defaults. */
      statusId?: string | null;
      alertStaffId?: string | null;
      normalizePhone?: boolean;
      expectedVersion?: number;
    },
  ): Promise<ConnectionRoute> {
    const values = [
      input.companyId,
      input.connectionId,
      input.workshopId,
      input.crmAccountId,
      input.funnelId,
      input.defaultOwnerId,
      input.technicalSourceId,
      input.statusId ?? null,
      input.alertStaffId ?? null,
      input.normalizePhone ?? false,
    ];
    const columns = `company_id, connection_id, workshop_id, crm_account_id, funnel_id,
                     default_owner_id, technical_source_id, status_id, alert_staff_id,
                     normalize_phone, version`;

    // Only version 0 (or no expectation) may create. A concurrent creator must not
    // turn a CAS race into a unique-violation 500, so the insert is DO NOTHING and
    // the existing row is then checked below.
    const mayInsert = input.expectedVersion === undefined || input.expectedVersion === 0;
    if (mayInsert) {
      const inserted = await tx.query<RouteRow>(
        `INSERT INTO ${this.q('connection_routes')}
           (company_id,connection_id,workshop_id,crm_account_id,funnel_id,default_owner_id,
            technical_source_id,status_id,alert_staff_id,normalize_phone,version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1)
         ON CONFLICT (company_id,connection_id) DO NOTHING
         RETURNING ${columns}`,
        values,
      );
      const insertedRow = inserted.rows[0];
      if (insertedRow) return toRoute(insertedRow);
    }

    const existing = await tx.query<RouteRow>(
      `SELECT ${columns}
         FROM ${this.q('connection_routes')}
        WHERE company_id=$1 AND connection_id=$2
        FOR UPDATE`,
      [input.companyId, input.connectionId],
    );
    const current = existing.rows[0];
    if (!current) {
      // The caller expected an existing route that is not there: version 0 is current.
      if (input.expectedVersion !== undefined) throw new WorkshopConflictError(0);
      throw new Error('ROUTE_UPSERT_FAILED');
    }
    if (input.expectedVersion !== undefined && Number(current.version) !== input.expectedVersion) {
      throw new WorkshopConflictError(Number(current.version));
    }
    const updated = await tx.query<RouteRow>(
      `UPDATE ${this.q('connection_routes')}
          SET workshop_id=$3, crm_account_id=$4, funnel_id=$5, default_owner_id=$6,
              technical_source_id=$7, status_id=$8, alert_staff_id=$9, normalize_phone=$10,
              version=version+1, updated_at=now()
        WHERE company_id=$1 AND connection_id=$2
        RETURNING ${columns}`,
      values,
    );
    const row = updated.rows[0];
    if (!row) throw new Error('ROUTE_UPSERT_FAILED');
    return toRoute(row);
  }

  /**
   * Changes only what the admin routing screen edits: the funnel, the stage new
   * deals start on, who hears about a broken channel, and the phone rule. Workshop,
   * owner and technical source stay untouched, so this cannot be used to move a
   * route between workshops.
   *
   * Returns null when the connection has no route yet: routing settings have no
   * meaning without the workshop and source a projection writes with.
   */
  async updateConnectionRouting(input: {
    companyId: string;
    connectionId: string;
    funnelId: string;
    statusId: string | null;
    alertStaffId: string | null;
    normalizePhone: boolean;
    expectedVersion?: number;
  }): Promise<ConnectionRoute | null> {
    const { rows } = await this.db.query<RouteRow>(
      `UPDATE ${this.q('connection_routes')}
          SET funnel_id=$3, status_id=$4, alert_staff_id=$5, normalize_phone=$6,
              version=version+1, updated_at=now()
        WHERE company_id=$1 AND connection_id=$2
          AND ($7::bigint IS NULL OR version=$7)
        RETURNING company_id, connection_id, workshop_id, crm_account_id, funnel_id,
                  default_owner_id, technical_source_id, status_id, alert_staff_id,
                  normalize_phone, version`,
      [
        input.companyId,
        input.connectionId,
        input.funnelId,
        input.statusId,
        input.alertStaffId,
        input.normalizePhone,
        input.expectedVersion ?? null,
      ],
    );
    return rows[0] ? toRoute(rows[0]) : null;
  }

  async getConnectionRoute(companyId: string, connectionId: string): Promise<ConnectionRoute | null> {
    const { rows } = await this.db.query<RouteRow>(
      `SELECT company_id, connection_id, workshop_id, crm_account_id, funnel_id,
              default_owner_id, technical_source_id, status_id, alert_staff_id,
              normalize_phone, version
         FROM ${this.q('connection_routes')} WHERE company_id=$1 AND connection_id=$2`,
      [companyId, connectionId],
    );
    return rows[0] ? toRoute(rows[0]) : null;
  }

  async listWorkshopRoutes(companyId: string, workshopId: string): Promise<ConnectionRoute[]> {
    const { rows } = await this.db.query<RouteRow>(
      `SELECT company_id, connection_id, workshop_id, crm_account_id, funnel_id,
              default_owner_id, technical_source_id, status_id, alert_staff_id,
              normalize_phone, version
         FROM ${this.q('connection_routes')}
        WHERE company_id=$1 AND workshop_id=$2 ORDER BY connection_id`,
      [companyId, workshopId],
    );
    return rows.map(toRoute);
  }

  /** Read/send grants of every connection routed to the workshop. */
  async listWorkshopPermissions(
    companyId: string,
    workshopId: string,
  ): Promise<Array<{ connectionId: string; staffId: string; canRead: boolean; canSend: boolean }>> {
    const { rows } = await this.db.query<{
      connection_id: string;
      staff_id: string;
      can_read: boolean;
      can_send: boolean;
    }>(
      `SELECT p.connection_id, p.staff_id, p.can_read, p.can_send
         FROM ${this.q('channel_permissions')} p
         JOIN ${this.q('connection_routes')} r
           ON r.company_id=p.company_id AND r.connection_id=p.connection_id
        WHERE p.company_id=$1 AND r.workshop_id=$2
        ORDER BY p.connection_id, p.staff_id`,
      [companyId, workshopId],
    );
    return rows.map((row) => ({
      connectionId: row.connection_id,
      staffId: row.staff_id,
      canRead: row.can_read,
      canSend: row.can_send,
    }));
  }

  // --- channel permissions (read and send are separate facts) ---------------------

  async setChannelPermission(input: {
    companyId: string;
    connectionId: string;
    staffId: string;
    canRead: boolean;
    canSend: boolean;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO ${this.q('channel_permissions')}
         (company_id,connection_id,staff_id,can_read,can_send,version)
       VALUES ($1,$2,$3,$4,$5,1)
       ON CONFLICT (company_id,connection_id,staff_id) DO UPDATE
         SET can_read=EXCLUDED.can_read,
             can_send=EXCLUDED.can_send,
             version=${this.q('channel_permissions')}.version+1`,
      [input.companyId, input.connectionId, input.staffId, input.canRead, input.canSend],
    );
  }

  /**
   * The route together with its read/send grants: the administrative view of one
   * connection. It never returns credential material.
   */
  async describeRoute(
    companyId: string,
    connectionId: string,
  ): Promise<{
    route: ConnectionRoute;
    permissions: Array<{ staffId: string; canRead: boolean; canSend: boolean }>;
  } | null> {
    const route = await this.getConnectionRoute(companyId, connectionId);
    if (!route) return null;
    const { rows } = await this.db.query<{ staff_id: string; can_read: boolean; can_send: boolean }>(
      `SELECT staff_id, can_read, can_send FROM ${this.q('channel_permissions')}
        WHERE company_id=$1 AND connection_id=$2 ORDER BY staff_id`,
      [companyId, connectionId],
    );
    return {
      route,
      permissions: rows.map((row) => ({
        staffId: row.staff_id,
        canRead: row.can_read,
        canSend: row.can_send,
      })),
    };
  }

  async getChannelPermission(
    companyId: string,
    connectionId: string,
    staffId: string,
  ): Promise<{ canRead: boolean; canSend: boolean } | null> {
    const { rows } = await this.db.query<{ can_read: boolean; can_send: boolean }>(
      `SELECT can_read, can_send FROM ${this.q('channel_permissions')}
        WHERE company_id=$1 AND connection_id=$2 AND staff_id=$3`,
      [companyId, connectionId, staffId],
    );
    const row = rows[0];
    return row ? { canRead: row.can_read, canSend: row.can_send } : null;
  }

  /**
   * Read and send are decided independently. The route is checked first: an
   * unrouted connection has no workshop, so nobody may act on it. Revoking either
   * flag takes effect on the next call because the row is read here, not cached.
   */
  private async authorize(
    input: { companyId: string; connectionId: string; staffId: string },
    permission: 'read' | 'send',
  ): Promise<AccessDecision> {
    const route = await this.getConnectionRoute(input.companyId, input.connectionId);
    if (!route) return { allowed: false, reason: 'route_missing' };
    // A connection grant only applies inside the workshop the route belongs to.
    const { rowCount } = await this.db.query(
      `SELECT 1 FROM ${this.q('workshop_staff')}
        WHERE company_id=$1 AND workshop_id=$2 AND staff_id=$3`,
      [input.companyId, route.workshopId, input.staffId],
    );
    if ((rowCount ?? 0) === 0) return { allowed: false, reason: 'workshop_mismatch' };
    const grant = await this.getChannelPermission(input.companyId, input.connectionId, input.staffId);
    if (!grant) return { allowed: false, reason: 'permission_missing' };
    const allowed = permission === 'read' ? grant.canRead : grant.canSend;
    if (!allowed) return { allowed: false, reason: permission === 'read' ? 'read_denied' : 'send_denied' };
    return { allowed: true, reason: 'allowed' };
  }

  async authorizeRead(input: {
    companyId: string;
    connectionId: string;
    staffId: string;
  }): Promise<AccessDecision> {
    return this.authorize(input, 'read');
  }

  async authorizeSend(input: {
    companyId: string;
    connectionId: string;
    staffId: string;
  }): Promise<AccessDecision> {
    return this.authorize(input, 'send');
  }

  // --- inbound routing ------------------------------------------------------------

  /**
   * Resolves the workshop for an inbound event from the connection and the
   * immutable external chat id. The chat id is looked up inside the connection and
   * binding epoch, so the same external id on another connection cannot leak the
   * workshop. The group filter is applied here, before any CRM projection exists.
   */
  async resolveInbound(input: {
    companyId: string;
    connectionId: string;
    externalChatId: string;
    chatKind: ChatKind;
  }): Promise<InboundResolution | null> {
    const route = await this.getConnectionRoute(input.companyId, input.connectionId);
    if (!route) return null;

    const { rows: connectionRows } = await this.db.query<{ binding_epoch: string | number }>(
      `SELECT binding_epoch FROM ${this.q('connections')} WHERE company_id=$1 AND id=$2`,
      [input.companyId, input.connectionId],
    );
    const bindingEpoch = connectionRows[0] ? Number(connectionRows[0].binding_epoch) : 0;

    // The group/unknown gate is the single policy implementation; routing only
    // reads its verdict and never re-derives it.
    const decision = await this.groups.decide({
      companyId: input.companyId,
      connectionId: input.connectionId,
      bindingEpoch,
      externalChatId: input.externalChatId,
      chatKind: input.chatKind,
    });

    return {
      workshopId: route.workshopId,
      crmAccountId: route.crmAccountId,
      funnelId: route.funnelId,
      defaultOwnerId: route.defaultOwnerId,
      technicalSourceId: route.technicalSourceId,
      routeVersion: route.version,
      crmImportAllowed: decision.allowed,
      chatDecision: { allowed: decision.allowed, reason: decision.reason },
    };
  }

  // --- CRM sources ----------------------------------------------------------------

  /**
   * The technical source of a connection is a distinct entity from the customer's
   * advertising origin. Creating it writes only `crm_sources`; it never touches the
   * marketing origin of a conversation.
   */
  async bindTechnicalSource(input: {
    companyId: string;
    accountId: string;
    externalId: string;
    originCode: string;
  }): Promise<TechnicalSource> {
    const { rows } = await this.db.query<{
      id: string;
      external_id: string;
      origin_code: string;
      source_kind: string;
    }>(
      `INSERT INTO ${this.q('crm_sources')}
         (company_id,id,account_id,external_id,origin_code,source_kind)
       VALUES ($1,$2,$3,$4,$5,'technical_chat')
       ON CONFLICT (company_id,account_id,external_id) DO UPDATE
         SET origin_code=EXCLUDED.origin_code
       RETURNING id, external_id, origin_code, source_kind`,
      [
        input.companyId,
        `src_${input.accountId}_${input.externalId}`,
        input.accountId,
        input.externalId,
        input.originCode,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('SOURCE_UPSERT_FAILED');
    return {
      id: row.id,
      externalId: row.external_id,
      originCode: row.origin_code,
      sourceKind: row.source_kind,
    };
  }

  /**
   * Records the advertising origin observed for a conversation. The first
   * observation wins: a later call returns the stored origin unchanged, so a
   * technical channel binding can never overwrite marketing attribution.
   */
  async recordMarketingOrigin(input: {
    companyId: string;
    accountId: string;
    conversationId: string;
    originCode: string;
    sourceRef?: string | null;
  }): Promise<MarketingOrigin> {
    await this.db.query(
      `INSERT INTO ${this.q('crm_marketing_origins')}
         (company_id,account_id,conversation_id,origin_code,source_ref)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (company_id,account_id,conversation_id) DO NOTHING`,
      [input.companyId, input.accountId, input.conversationId, input.originCode, input.sourceRef ?? null],
    );
    const stored = await this.getMarketingOrigin(input.companyId, input.accountId, input.conversationId);
    if (!stored) throw new Error('MARKETING_ORIGIN_MISSING');
    return stored;
  }

  async getMarketingOrigin(
    companyId: string,
    accountId: string,
    conversationId: string,
  ): Promise<MarketingOrigin | null> {
    const { rows } = await this.db.query<{ origin_code: string; source_ref: string | null }>(
      `SELECT origin_code, source_ref FROM ${this.q('crm_marketing_origins')}
        WHERE company_id=$1 AND account_id=$2 AND conversation_id=$3`,
      [companyId, accountId, conversationId],
    );
    const row = rows[0];
    return row ? { originCode: row.origin_code, sourceRef: row.source_ref } : null;
  }
}

export type { Db, Tx };
