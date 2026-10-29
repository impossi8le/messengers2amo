import type {FastifyInstance} from 'fastify';
import {requireRole} from '../app.ts';
import {buildChannelCatalog} from './catalog.ts';

export function registerChannelCatalogRoutes(app:FastifyInstance):void {
 app.get('/api/v2/operator/channels/catalog',async(request,reply)=>{
  if(!requireRole(request,reply,'admin'))return;
  return {schemaVersion:1,items:buildChannelCatalog().map(entry=>({...entry,
   setupAvailable:entry.id==='telegram_bot',verification:'unverified' as const}))};
 });
}
