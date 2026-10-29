import {createHash,createHmac,timingSafeEqual} from 'node:crypto';

const CONTENT_TYPE='application/json';
const METHODS=new Set(['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS']);
const HEADER_DATE=/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), [0-9]{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/;
const SIGNATURE=/^[a-fA-F0-9]{40}$/;

function optionsObject(value){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError('Invalid protocol options');
  return value;
}

function rawBytes(value){
  if(!(value instanceof Uint8Array))throw new TypeError('Raw body must be bytes');
  return Buffer.from(value);
}

function secretBytes(value){
  if(typeof value==='string'){
    if(value.length===0)throw new TypeError('Invalid channel secret');
    return Buffer.from(value,'utf8');
  }
  if(value instanceof Uint8Array&&value.byteLength>0)return Buffer.from(value);
  throw new TypeError('Invalid channel secret');
}

function requestMethod(value){
  if(typeof value!=='string')throw new TypeError('Invalid HTTP method');
  const method=value.toUpperCase();
  if(!METHODS.has(method))throw new TypeError('Invalid HTTP method');
  return method;
}

function requestPath(value){
  if(typeof value!=='string'||!value.startsWith('/')||value.startsWith('//')||/[\x00-\x20\x7f\\#]/.test(value)){
    throw new TypeError('Invalid request path');
  }
  return value.split('?',1)[0];
}

function requestDate(value){
  if(typeof value!=='string'||!HEADER_DATE.test(value))throw new TypeError('Invalid request date');
  const parsed=Date.parse(value);
  if(!Number.isFinite(parsed)||new Date(parsed).toUTCString()!==value)throw new TypeError('Invalid request date');
  return value;
}

export function signChatsRequest(options){
  const input=optionsObject(options);
  const method=requestMethod(input.method);
  const path=requestPath(input.urlPath);
  const date=requestDate(input.date);
  if(input.contentType!==undefined&&input.contentType!==CONTENT_TYPE)throw new TypeError('Invalid content type');
  const rawBody=method==='GET'&&input.rawBody===undefined?Buffer.alloc(0):rawBytes(input.rawBody);
  if(method==='GET'&&rawBody.length!==0)throw new TypeError('GET body must be empty');
  const key=secretBytes(input.channelSecret);
  const checksum=createHash('md5').update(rawBody).digest('hex');
  const canonical=[method,checksum,CONTENT_TYPE,date,path].join('\n');
  const signature=createHmac('sha1',key).update(canonical,'utf8').digest('hex');
  return {'Date':date,'Content-Type':CONTENT_TYPE,'Content-MD5':checksum,'X-Signature':signature};
}

export function verifyChatsWebhook(options){
  const input=optionsObject(options);
  const rawBody=rawBytes(input.rawBody);
  const key=secretBytes(input.channelSecret);
  const signature=input.signature;
  if(typeof signature!=='string'||signature.length!==40||!SIGNATURE.test(signature))return false;
  const expected=createHmac('sha1',key).update(rawBody).digest();
  return timingSafeEqual(expected,Buffer.from(signature,'hex'));
}
