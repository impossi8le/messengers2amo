import { createHash } from 'node:crypto';
import { withTransaction,type Db } from '../../platform/db.ts';
import { writeAudit } from '../../platform/audit.ts';
import type { CrmDirectoryClient } from './directory-client.ts';

export type ChannelCrmRole = 'manager' | 'supervisor' | 'quality';
export class DirectoryError extends Error {
  readonly code: 'NOT_FOUND' | 'VERSION_CONFLICT' | 'VALIDATION_FAILED' | 'UPSTREAM_UNAVAILABLE';
  constructor(code: DirectoryError['code']) { super(code);this.code=code; }
}

export class CrmDirectory {
  private db: Db;
  private schema: string;
  private client?: CrmDirectoryClient;
  constructor(deps:{db:Db;schema:string;client?:CrmDirectoryClient}) {
    if(!/^[a-z_][a-z0-9_]{0,62}$/.test(deps.schema))throw new Error('INVALID_SCHEMA');
    this.db=deps.db;this.schema=deps.schema;this.client=deps.client;
  }
  private q(name:string){return `"${this.schema}"."${name}"`;}
  async read(companyId:string,accountId:string) {
    return withTransaction(this.db,async(tx)=>{
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const account=await tx.query(`SELECT id FROM ${this.q('crm_accounts')} WHERE company_id=$1 AND id=$2`,[companyId,accountId]);
    if(!account.rows.length)throw new DirectoryError('NOT_FOUND');
    const users=await tx.query(`SELECT crm_user_ref AS id,staff_id AS "staffId",display_name AS name,is_active AS "isActive",crm_is_admin AS "isCrmAdmin",
        role_id AS "roleId",role_name AS "roleName",group_name AS "groupName",amojo_user_ref IS NOT NULL AS "chatIdentityAvailable"
        FROM ${this.q('crm_directory_users')} WHERE company_id=$1 AND account_id=$2 ORDER BY display_name,crm_user_ref`,[companyId,accountId]);
    const roles=await tx.query(`SELECT id,display_name AS name FROM ${this.q('crm_directory_roles')} WHERE company_id=$1 AND account_id=$2 ORDER BY display_name,id`,[companyId,accountId]);
    const sync=await tx.query<{version:string;last_success_at:Date|null;last_error_code:string|null}>(`SELECT version,last_success_at,last_error_code FROM ${this.q('crm_directory_sync')} WHERE company_id=$1 AND account_id=$2`,[companyId,accountId]);
    const channels=await tx.query(`SELECT c.id,COALESCE(c.display_name,c.id) AS name FROM ${this.q('connections')} c JOIN ${this.q('connection_routes')} r
        ON r.company_id=c.company_id AND r.connection_id=c.id WHERE r.company_id=$1 AND r.crm_account_id=$2 ORDER BY c.id`,[companyId,accountId]);
    return {accountId,users:users.rows,roles:roles.rows,channels:channels.rows,refreshEnabled:Boolean(this.client),
      version:Number(sync.rows[0]?.version??0),lastSuccessAt:sync.rows[0]?.last_success_at?.toISOString()??null,
      errorCode:sync.rows[0]?.last_error_code??null};
    });
  }
  async refresh(input:{companyId:string;accountId:string;actorId:string}) {
    if(!this.client)throw new DirectoryError('UPSTREAM_UNAVAILABLE');
    const generation=await withTransaction(this.db,async(tx)=>{
      const account=await tx.query(`SELECT id FROM ${this.q('crm_accounts')} WHERE company_id=$1 AND id=$2 AND state='active' FOR UPDATE`,[input.companyId,input.accountId]);
      if(!account.rows.length)throw new DirectoryError('NOT_FOUND');
      const result=await tx.query<{generation:string}>(`INSERT INTO ${this.q('crm_directory_sync')}(company_id,account_id,generation)
        VALUES ($1,$2,1) ON CONFLICT(company_id,account_id) DO UPDATE SET generation=${this.q('crm_directory_sync')}.generation+1 RETURNING generation`,[input.companyId,input.accountId]);
      return result.rows[0]!.generation;
    });
    let snapshot;
    try {snapshot=await this.client.load(input);}
    catch(error) {
      await this.db.query(`UPDATE ${this.q('crm_directory_sync')} SET last_error_code='directory_refresh_failed' WHERE company_id=$1 AND account_id=$2 AND generation=$3`,[input.companyId,input.accountId,generation]);
      throw error;
    }
    await withTransaction(this.db,async(tx)=>{
      const current=await tx.query<{generation:string}>(`SELECT generation FROM ${this.q('crm_directory_sync')} WHERE company_id=$1 AND account_id=$2 FOR UPDATE`,[input.companyId,input.accountId]);
      if(current.rows[0]?.generation!==generation)throw new DirectoryError('VERSION_CONFLICT');
      await tx.query(`UPDATE ${this.q('crm_directory_users')} SET is_active=false WHERE company_id=$1 AND account_id=$2`,[input.companyId,input.accountId]);
      await tx.query(`DELETE FROM ${this.q('crm_directory_roles')} WHERE company_id=$1 AND account_id=$2`,[input.companyId,input.accountId]);
      for(const role of snapshot.roles)await tx.query(`INSERT INTO ${this.q('crm_directory_roles')}(company_id,account_id,id,display_name) VALUES ($1,$2,$3,$4)`,[input.companyId,input.accountId,role.id,role.name]);
      for(const user of snapshot.users) {
        const mappings=await tx.query<{staff_id:string}>(`SELECT staff_id FROM ${this.q('staff_crm_refs')} WHERE company_id=$1 AND account_id=$2 AND crm_user_ref=$3 LIMIT 2`,[input.companyId,input.accountId,user.id]);
        if(mappings.rows.length>1)throw new DirectoryError('VERSION_CONFLICT');
        const staffId=mappings.rows[0]?.staff_id??`crm_${createHash('sha256').update(JSON.stringify([input.companyId,input.accountId,user.id])).digest('hex').slice(0,32)}`;
        await tx.query(`INSERT INTO ${this.q('staff')}(company_id,id,display_name) VALUES ($1,$2,$3) ON CONFLICT(company_id,id) DO NOTHING`,[input.companyId,staffId,user.name]);
        await tx.query(`INSERT INTO ${this.q('staff_crm_refs')}(company_id,account_id,staff_id,crm_user_ref) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[input.companyId,input.accountId,staffId,user.id]);
        await tx.query(`INSERT INTO ${this.q('crm_directory_users')}(company_id,account_id,crm_user_ref,staff_id,display_name,amojo_user_ref,is_active,crm_is_admin,role_id,role_name,group_id,group_name)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(company_id,account_id,crm_user_ref) DO UPDATE
          SET staff_id=EXCLUDED.staff_id,display_name=EXCLUDED.display_name,amojo_user_ref=EXCLUDED.amojo_user_ref,is_active=EXCLUDED.is_active,
            crm_is_admin=EXCLUDED.crm_is_admin,role_id=EXCLUDED.role_id,role_name=EXCLUDED.role_name,group_id=EXCLUDED.group_id,group_name=EXCLUDED.group_name,imported_at=now()`,
          [input.companyId,input.accountId,user.id,staffId,user.name,user.amojoId,user.isActive,user.isAdmin,user.roleId,user.roleName,user.groupId,user.groupName]);
      }
      await tx.query(`UPDATE ${this.q('channel_permissions')} p SET can_read=u.is_active,can_send=u.is_active AND a.role<>'quality',version=p.version+1
        FROM ${this.q('channel_crm_access')} a JOIN ${this.q('crm_directory_users')} u
          ON u.company_id=a.company_id AND u.account_id=a.account_id AND u.crm_user_ref=a.crm_user_ref
        WHERE a.company_id=$1 AND a.account_id=$2 AND p.company_id=a.company_id AND p.connection_id=a.connection_id AND p.staff_id=u.staff_id`,[input.companyId,input.accountId]);
      await tx.query(`UPDATE ${this.q('crm_directory_sync')} SET version=version+1,last_success_at=clock_timestamp(),last_error_code=NULL WHERE company_id=$1 AND account_id=$2`,[input.companyId,input.accountId]);
      await writeAudit(tx,{companyId:input.companyId,eventName:'crm.directory_refreshed',subjectId:input.accountId,actorId:input.actorId,diagnosticCode:`users=${snapshot.users.length};roles=${snapshot.roles.length}`});
    });
    return this.read(input.companyId,input.accountId);
  }
  async readAccess(companyId:string,connectionId:string) {
    const route=(await this.db.query<{account_id:string;version:string;enabled:boolean}>(`SELECT r.crm_account_id AS account_id,c.version,c.crm_access_enabled AS enabled
      FROM ${this.q('connections')} c JOIN ${this.q('connection_routes')} r ON r.company_id=c.company_id AND r.connection_id=c.id
      WHERE c.company_id=$1 AND c.id=$2`,[companyId,connectionId])).rows[0];
    if(!route)throw new DirectoryError('NOT_FOUND');
    const grants=await this.db.query(`SELECT crm_user_ref AS "crmUserId",role FROM ${this.q('channel_crm_access')} WHERE company_id=$1 AND connection_id=$2 AND account_id=$3 ORDER BY crm_user_ref`,[companyId,connectionId,route.account_id]);
    return {connectionId,accountId:route.account_id,version:Number(route.version),enforced:route.enabled,grants:grants.rows};
  }
  async saveAccess(input:{companyId:string;connectionId:string;accountId:string;actorId:string;expectedVersion:number;grants:Array<{crmUserId:string;role:ChannelCrmRole}>}) {
    if(new Set(input.grants.map((g)=>g.crmUserId)).size!==input.grants.length)throw new DirectoryError('VALIDATION_FAILED');
    await withTransaction(this.db,async(tx)=>{
      const route=(await tx.query<{crm_account_id:string;workshop_id:string;version:string}>(`SELECT r.crm_account_id,r.workshop_id,c.version FROM ${this.q('connections')} c JOIN ${this.q('connection_routes')} r
        ON r.company_id=c.company_id AND r.connection_id=c.id WHERE c.company_id=$1 AND c.id=$2 FOR UPDATE OF c,r`,[input.companyId,input.connectionId])).rows[0];
      if(!route)throw new DirectoryError('NOT_FOUND');
      if(route.crm_account_id!==input.accountId || Number(route.version)!==input.expectedVersion)throw new DirectoryError('VERSION_CONFLICT');
      const users=await tx.query<{crm_user_ref:string;staff_id:string;is_active:boolean}>(`SELECT crm_user_ref,staff_id,is_active FROM ${this.q('crm_directory_users')}
        WHERE company_id=$1 AND account_id=$2 AND crm_user_ref=ANY($3::text[]) FOR SHARE`,[input.companyId,input.accountId,input.grants.map((g)=>g.crmUserId)]);
      if(users.rows.length!==input.grants.length)throw new DirectoryError('VALIDATION_FAILED');
      // Remove only grants previously managed by this directory policy.
      await tx.query(`DELETE FROM ${this.q('channel_permissions')} p USING ${this.q('channel_crm_access')} a,${this.q('crm_directory_users')} u
        WHERE a.company_id=$1 AND a.connection_id=$2 AND u.company_id=a.company_id AND u.account_id=a.account_id AND u.crm_user_ref=a.crm_user_ref
          AND p.company_id=a.company_id AND p.connection_id=a.connection_id AND p.staff_id=u.staff_id`,[input.companyId,input.connectionId]);
      await tx.query(`DELETE FROM ${this.q('channel_crm_access')} WHERE company_id=$1 AND connection_id=$2`,[input.companyId,input.connectionId]);
      for(const grant of input.grants) {
        const user=users.rows.find((u)=>u.crm_user_ref===grant.crmUserId)!;
        await tx.query(`INSERT INTO ${this.q('channel_crm_access')}(company_id,connection_id,account_id,crm_user_ref,role) VALUES ($1,$2,$3,$4,$5)`,[input.companyId,input.connectionId,input.accountId,grant.crmUserId,grant.role]);
        await tx.query(`INSERT INTO ${this.q('workshop_staff')}(company_id,workshop_id,staff_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,[input.companyId,route.workshop_id,user.staff_id]);
        await tx.query(`INSERT INTO ${this.q('channel_permissions')}(company_id,connection_id,staff_id,can_read,can_send,version) VALUES ($1,$2,$3,$4,$5,1)
          ON CONFLICT(company_id,connection_id,staff_id) DO UPDATE SET can_read=EXCLUDED.can_read,can_send=EXCLUDED.can_send,version=${this.q('channel_permissions')}.version+1`,
          [input.companyId,input.connectionId,user.staff_id,user.is_active,user.is_active&&grant.role!=='quality']);
      }
      await tx.query(`UPDATE ${this.q('connections')} SET crm_access_enabled=true,version=version+1 WHERE company_id=$1 AND id=$2`,[input.companyId,input.connectionId]);
      await writeAudit(tx,{companyId:input.companyId,eventName:'crm.channel_access_updated',subjectId:input.connectionId,actorId:input.actorId,diagnosticCode:`grants=${input.grants.length}`});
    });
    return this.readAccess(input.companyId,input.connectionId);
  }
}
