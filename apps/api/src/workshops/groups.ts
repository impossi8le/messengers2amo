// Group (and unknown-chat) policy for one connection.
//
// The decision is made from the immutable external chat id inside a connection and
// binding epoch. Names — of the chat or of the rule — are never inputs. Groups and
// unknown chats are denied for CRM projection by default; only an explicit
// `allow_crm` rule admits a group. This module is the gate that must run before any
// CRM projection is planned, and it reads the same deny-by-default policy the
// database function `channel_crm_import_allowed` enforces.

import type { Db, Tx } from '../platform/db.ts';
import { qualified } from '../integrations/amocrm/store.ts';

export type ChatKind = 'private' | 'group' | 'unknown';
export type GroupRuleDecision = 'allow_crm' | 'exclude' | 'archive_only';

export type GroupDecisionName =
  | 'private_allowed'
  | 'group_allowed'
  | 'group_default_deny'
  | 'group_excluded'
  | 'archive_only'
  | 'unknown_chat_kind'
  | 'projection_disabled'
  | 'private_import_disabled'
  | 'policy_missing';

export type GroupDecision = {
  allowed: boolean;
  decision: GroupDecisionName;
  reason: string;
  /** True only for an explicit `archive_only` rule; never implied by a deny. */
  archiveOnly: boolean;
  ruleVersion: number | null;
};

export type GroupRule = {
  companyId: string;
  connectionId: string;
  bindingEpoch: number;
  externalChatId: string;
  decision: GroupRuleDecision;
  displayName: string | null;
  version: number;
};

export type GroupPolicyDeps = { db: Db; schema?: string };

type PolicyRow = { crm_projection_enabled: boolean; private_import_enabled: boolean };
type RuleRow = {
  decision: GroupRuleDecision;
  display_name: string | null;
  version: string | number;
};

function toRule(row: RuleRow & {
  company_id: string;
  connection_id: string;
  binding_epoch: string | number;
  external_chat_id: string;
}): GroupRule {
  return {
    companyId: row.company_id,
    connectionId: row.connection_id,
    bindingEpoch: Number(row.binding_epoch),
    externalChatId: row.external_chat_id,
    decision: row.decision,
    displayName: row.display_name,
    version: Number(row.version),
  };
}

export class GroupPolicyService {
  private readonly db: Db;
  private readonly schema: string | undefined;

  constructor(deps: GroupPolicyDeps) {
    this.db = deps.db;
    this.schema = deps.schema;
  }

  private q(name: string): string {
    return qualified(this.schema, name);
  }

  /**
   * Decides whether an event may reach the CRM. Order matters: the unknown chat
   * kind and a missing/disabled policy are denied before any rule is consulted,
   * and a rule can only widen the group case, never the unknown one.
   */
  async decide(input: {
    companyId: string;
    connectionId: string;
    bindingEpoch: number;
    externalChatId: string;
    chatKind: ChatKind;
  }): Promise<GroupDecision> {
    const { rows: policyRows } = await this.db.query<PolicyRow>(
      `SELECT crm_projection_enabled, private_import_enabled FROM ${this.q('channel_policies')}
        WHERE company_id=$1 AND connection_id=$2`,
      [input.companyId, input.connectionId],
    );
    const policy = policyRows[0];
    if (!policy) {
      return { allowed: false, decision: 'policy_missing', reason: 'policy_missing', archiveOnly: false, ruleVersion: null };
    }
    if (!policy.crm_projection_enabled) {
      return {
        allowed: false,
        decision: 'projection_disabled',
        reason: 'projection_disabled',
        archiveOnly: false,
        ruleVersion: null,
      };
    }
    if (input.chatKind === 'unknown') {
      return {
        allowed: false,
        decision: 'unknown_chat_kind',
        reason: 'unknown_chat_kind',
        archiveOnly: false,
        ruleVersion: null,
      };
    }
    if (input.chatKind === 'private') {
      return policy.private_import_enabled
        ? { allowed: true, decision: 'private_allowed', reason: 'allowed', archiveOnly: false, ruleVersion: null }
        : {
            allowed: false,
            decision: 'private_import_disabled',
            reason: 'private_import_disabled',
            archiveOnly: false,
            ruleVersion: null,
          };
    }

    const { rows } = await this.db.query<RuleRow>(
      `SELECT decision, display_name, version FROM ${this.q('channel_group_rules')}
        WHERE company_id=$1 AND connection_id=$2 AND binding_epoch=$3 AND external_chat_id=$4`,
      [input.companyId, input.connectionId, input.bindingEpoch, input.externalChatId],
    );
    const rule = rows[0];
    if (!rule) {
      return {
        allowed: false,
        decision: 'group_default_deny',
        reason: 'group_default_deny',
        archiveOnly: false,
        ruleVersion: null,
      };
    }
    if (rule.decision === 'allow_crm') {
      return {
        allowed: true,
        decision: 'group_allowed',
        reason: 'allowed',
        archiveOnly: false,
        ruleVersion: Number(rule.version),
      };
    }
    if (rule.decision === 'archive_only') {
      return {
        allowed: false,
        decision: 'archive_only',
        reason: 'archive_only',
        archiveOnly: true,
        ruleVersion: Number(rule.version),
      };
    }
    return {
      allowed: false,
      decision: 'group_excluded',
      reason: 'group_excluded',
      archiveOnly: false,
      ruleVersion: Number(rule.version),
    };
  }

  /**
   * Creates or re-decides the rule for one immutable group identity. The identity
   * columns are protected by a trigger; only the decision, label and version move.
   */
  async setRule(input: {
    companyId: string;
    connectionId: string;
    bindingEpoch: number;
    externalChatId: string;
    decision: GroupRuleDecision;
    displayName?: string | null;
  }): Promise<GroupRule> {
    return this.upsertRule(this.db, input);
  }

  /** Same upsert on the caller's transaction, so the audit row commits with it. */
  async setRuleInTransaction(
    tx: Tx,
    input: {
      companyId: string;
      connectionId: string;
      bindingEpoch: number;
      externalChatId: string;
      decision: GroupRuleDecision;
      displayName?: string | null;
    },
  ): Promise<GroupRule> {
    return this.upsertRule(tx, input);
  }

  private async upsertRule(
    executor: Db | Tx,
    input: {
      companyId: string;
      connectionId: string;
      bindingEpoch: number;
      externalChatId: string;
      decision: GroupRuleDecision;
      displayName?: string | null;
    },
  ): Promise<GroupRule> {
    const { rows } = await executor.query(
      `INSERT INTO ${this.q('channel_group_rules')}
         (company_id,connection_id,binding_epoch,external_chat_id,decision,display_name,version)
       VALUES ($1,$2,$3,$4,$5,$6,1)
       ON CONFLICT (company_id,connection_id,binding_epoch,external_chat_id) DO UPDATE
         SET decision=EXCLUDED.decision,
             display_name=COALESCE(EXCLUDED.display_name, ${this.q('channel_group_rules')}.display_name),
             version=${this.q('channel_group_rules')}.version+1
       RETURNING company_id, connection_id, binding_epoch, external_chat_id, decision, display_name, version`,
      [
        input.companyId,
        input.connectionId,
        input.bindingEpoch,
        input.externalChatId,
        input.decision,
        input.displayName ?? null,
      ],
    );
    const row = rows[0] as
      | (RuleRow & {
          company_id: string;
          connection_id: string;
          binding_epoch: string | number;
          external_chat_id: string;
        })
      | undefined;
    if (!row) throw new Error('GROUP_RULE_UPSERT_FAILED');
    return toRule(row);
  }

  /** Rules of every connection routed to the workshop, optionally narrowed to one. */
  async listWorkshopRules(
    companyId: string,
    workshopId: string,
    filter: { connectionId?: string; bindingEpoch?: number } = {},
  ): Promise<GroupRule[]> {
    const params: unknown[] = [companyId, workshopId];
    let sql = `SELECT g.company_id, g.connection_id, g.binding_epoch, g.external_chat_id,
                      g.decision, g.display_name, g.version
                 FROM ${this.q('channel_group_rules')} g
                 JOIN ${this.q('connection_routes')} r
                   ON r.company_id=g.company_id AND r.connection_id=g.connection_id
                WHERE g.company_id=$1 AND r.workshop_id=$2`;
    if (filter.connectionId !== undefined) {
      params.push(filter.connectionId);
      sql += ` AND g.connection_id=$${params.length}`;
    }
    if (filter.bindingEpoch !== undefined) {
      params.push(filter.bindingEpoch);
      sql += ` AND g.binding_epoch=$${params.length}`;
    }
    sql += ' ORDER BY g.connection_id, g.binding_epoch, g.external_chat_id';
    const { rows } = await this.db.query(sql, params);
    return rows.map(toRule);
  }

  async listRules(companyId: string, connectionId: string, bindingEpoch: number): Promise<GroupRule[]> {
    const { rows } = await this.db.query(
      `SELECT company_id, connection_id, binding_epoch, external_chat_id, decision, display_name, version
         FROM ${this.q('channel_group_rules')}
        WHERE company_id=$1 AND connection_id=$2 AND binding_epoch=$3
        ORDER BY external_chat_id`,
      [companyId, connectionId, bindingEpoch],
    );
    return rows.map(toRule);
  }

  async deleteRule(input: {
    companyId: string;
    connectionId: string;
    bindingEpoch: number;
    externalChatId: string;
  }): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `DELETE FROM ${this.q('channel_group_rules')}
        WHERE company_id=$1 AND connection_id=$2 AND binding_epoch=$3 AND external_chat_id=$4`,
      [input.companyId, input.connectionId, input.bindingEpoch, input.externalChatId],
    );
    return (rowCount ?? 0) > 0;
  }
}

export type { Db, Tx };
