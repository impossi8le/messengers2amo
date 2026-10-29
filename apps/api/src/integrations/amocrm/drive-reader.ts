import {createHash} from 'node:crypto';

export type DriveFileScope={companyId:string;accountId:string;fileUuid:string;byteSize:number;sha256:string};
export type AmoDriveReader={download:(input:DriveFileScope)=>Promise<Uint8Array>};
const MAX_BYTES=20*1024*1024;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const DRIVE=/^drive(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?\.amocrm\.ru$/;

export class DriveReadError extends Error {
 readonly code:string;
 constructor(code='files_read_unavailable'){super(code);this.name='DriveReadError';this.code=code;}
}

function object(value:unknown):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new DriveReadError('files_invalid_metadata');
 return value as Record<string,unknown>;
}
function checkedUrl(raw:unknown,allowed:(host:string)=>boolean):URL{
 if(typeof raw!=='string'||raw.length>8192)throw new DriveReadError('files_invalid_download');
 let url:URL;try{url=new URL(raw);}catch{throw new DriveReadError('files_invalid_download');}
 if(url.protocol!=='https:'||url.port||url.username||url.password||url.hash||!allowed(url.hostname))throw new DriveReadError('files_invalid_download');
 return url;
}

/** Downloads only an already bound UUID. Fresh vendor links and OAuth never leave this reader. */
export function createAmoDriveReader(options:{accountDomain:string;
 getAccessToken:(scope:{companyId:string;accountId:string})=>Promise<string>;fetch:typeof fetch;
 timeoutMs?:number;allowedDownloadHosts?:readonly string[];
}):AmoDriveReader{
 if(!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.amocrm\.ru$/i.test(options.accountDomain))throw new DriveReadError('files_invalid_account');
 const timeoutMs=options.timeoutMs??15000;
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1)throw new DriveReadError('files_invalid_timeout');
 const cdn=new Set(options.allowedDownloadHosts??['hb.ru-msk.vkcloud-storage.ru']);
 return {async download(input){
  if(!UUID.test(input.fileUuid)||!Number.isSafeInteger(input.byteSize)||input.byteSize<0||input.byteSize>MAX_BYTES||!/^[a-f0-9]{64}$/.test(input.sha256))throw new DriveReadError('files_invalid_reference');
  const controller=new AbortController();let expire!:(error:Error)=>void;
  const deadline=new Promise<never>((_,reject)=>{expire=reject;});
  const timer=setTimeout(()=>{controller.abort();expire(new DriveReadError('files_read_timeout'));},timeoutMs);
  const request=(url:URL|string,init:RequestInit={})=>Promise.race([options.fetch(url.toString(),{redirect:'error',...init,signal:controller.signal}),deadline]);
  const read=async(response:Response,cap:number)=>{
   const length=response.headers.get('content-length');
   if(length!==null&&(!/^\d+$/.test(length)||Number(length)>cap)){void response.body?.cancel().catch(()=>{});throw new DriveReadError('files_read_too_large');}
   const reader=response.body?.getReader();if(!reader)return new Uint8Array();
   const parts:Uint8Array[]=[];let size=0;
   try{for(;;){const part=await Promise.race([reader.read(),deadline]);if(part.done)break;size+=part.value.byteLength;
    if(size>cap)throw new DriveReadError('files_read_too_large');parts.push(part.value);}}
   catch(error){void reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
   return new Uint8Array(Buffer.concat(parts,size));
  };
  const json=async(url:URL|string,token:string)=>{
   const response=await request(url,{headers:{authorization:`Bearer ${token}`,accept:'application/json'}});
   if(response.status!==200){void response.body?.cancel().catch(()=>{});throw new DriveReadError();}
   try{return object(JSON.parse(Buffer.from(await read(response,64*1024)).toString('utf8')));}catch(error){if(error instanceof DriveReadError)throw error;throw new DriveReadError('files_invalid_metadata');}
  };
  try{
   const token=await Promise.race([options.getAccessToken({companyId:input.companyId,accountId:input.accountId}),deadline]);
   const account=await json(`https://${options.accountDomain}/api/v4/account?with=drive_url`,token);
   const origin=checkedUrl(account.drive_url,host=>DRIVE.test(host));
   if(origin.pathname!=='/'||origin.search)throw new DriveReadError('files_invalid_download');
   const meta=await json(new URL(`/v1.0/files/${encodeURIComponent(input.fileUuid)}`,origin),token);
   if(meta.uuid!==input.fileUuid||meta.size!==input.byteSize||meta.is_trashed===true)throw new DriveReadError('files_invalid_metadata');
   const download=checkedUrl(object(object(meta._links).download).href,host=>DRIVE.test(host));
   let response=await request(download,{headers:{authorization:`Bearer ${token}`},redirect:'manual'});
   if([301,302,303,307,308].includes(response.status)){
    const location=response.headers.get('location');void response.body?.cancel().catch(()=>{});
    if(!location)throw new DriveReadError('files_invalid_download');
    const target=checkedUrl(new URL(location,download).toString(),host=>DRIVE.test(host)||cdn.has(host));
    // Even another vendor shard receives no original Authorization header on a redirect.
    response=await request(target);
   }
   if(response.status!==200){void response.body?.cancel().catch(()=>{});throw new DriveReadError();}
   const bytes=await read(response,input.byteSize);
   if(bytes.byteLength!==input.byteSize||createHash('sha256').update(bytes).digest('hex')!==input.sha256)throw new DriveReadError('files_integrity_mismatch');
   return bytes;
  }catch(error){if(error instanceof DriveReadError)throw error;throw new DriveReadError();}
  finally{clearTimeout(timer);}
 }};
}
