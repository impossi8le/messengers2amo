import type { FastifyInstance,FastifyRequest,FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../../app.ts';
import type { Db } from '../../platform/db.ts';
import { sendError } from '../../platform/errors.ts';
import { CrmDirectory,DirectoryError } from './directory.ts';
import type { CrmDirectoryClient } from './directory-client.ts';

const account=z.object({accountId:z.string().min(1).max(128)}).strict();
const params=z.object({id:z.string().min(1).max(128)}).strict();
const access=z.object({accountId:z.string().min(1).max(128),expectedVersion:z.number().int().min(0),
  grants:z.array(z.object({crmUserId:z.string().regex(/^[1-9][0-9]*$/).max(32),role:z.enum(['manager','supervisor','quality'])}).strict()).max(5000)}).strict();

export function registerCrmDirectoryRoutes(app:FastifyInstance,deps:{db:Db;schema:string;client?:CrmDirectoryClient}) {
  const directory=new CrmDirectory(deps);
  const admin=(request:FastifyRequest,reply:FastifyReply)=>{
    const session=requireRole(request,reply,'admin');
    if(!session)return null;
    if(session.workshopId!==null){sendError(reply,request.correlationId,'FORBIDDEN');return null;}
    return session;
  };
  const run=async(request:FastifyRequest,reply:FastifyReply,fn:()=>Promise<unknown>)=>{
    try{return reply.header('cache-control','no-store').send(await fn());}
    catch(error){
      if(error instanceof DirectoryError)return sendError(reply,request.correlationId,error.code);
      // Upstream body and private employee details never enter the response.
      return sendError(reply,request.correlationId,'UPSTREAM_UNAVAILABLE');
    }
  };
  app.get('/api/v2/operator/amocrm/directory',async(request,reply)=>{
    const session=admin(request,reply);if(!session)return reply;
    const query=account.safeParse(request.query);if(!query.success)return sendError(reply,request.correlationId,'VALIDATION_FAILED');
    return run(request,reply,()=>directory.read(session.companyId,query.data.accountId));
  });
  app.post('/api/v2/operator/amocrm/directory/refresh',async(request,reply)=>{
    const session=admin(request,reply);if(!session)return reply;
    const body=account.safeParse(request.body);if(!body.success)return sendError(reply,request.correlationId,'VALIDATION_FAILED');
    return run(request,reply,()=>directory.refresh({companyId:session.companyId,accountId:body.data.accountId,actorId:session.staffId}));
  });
  app.get('/api/v2/operator/connections/:id/crm-access',async(request,reply)=>{
    const session=admin(request,reply);if(!session)return reply;
    const path=params.safeParse(request.params);if(!path.success)return sendError(reply,request.correlationId,'VALIDATION_FAILED');
    return run(request,reply,()=>directory.readAccess(session.companyId,path.data.id));
  });
  app.patch('/api/v2/operator/connections/:id/crm-access',async(request,reply)=>{
    const session=admin(request,reply);if(!session)return reply;
    const path=params.safeParse(request.params);const body=access.safeParse(request.body);
    if(!path.success||!body.success)return sendError(reply,request.correlationId,'VALIDATION_FAILED');
    return run(request,reply,()=>directory.saveAccess({companyId:session.companyId,connectionId:path.data.id,actorId:session.staffId,...body.data}));
  });
}
