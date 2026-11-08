import {createRemoteJWKSet,jwtVerify} from 'jose';
import {createHmac,createHash,timingSafeEqual} from 'node:crypto';
import {blake3} from '@noble/hashes/blake3.js';
import type {IncomingMessage} from 'node:http';
import type {Actor,State} from '../../shared/autonomy/contracts.ts';
const issuer=process.env.OIDC_ISSUER||'http://localhost:8080/realms/relayaid';
const jwks=createRemoteJWKSet(new URL(process.env.OIDC_JWKS_URL||issuer+'/protocol/openid-connect/certs'));
export function identityFromClaims(iss:string,sub:string){const hash=blake3(new TextEncoder().encode(iss+'|'+sub)).slice(0,26);const check=blake3(Uint8Array.from([0xc2,0,...hash])).slice(0,4);return Buffer.from([0xc2,0,...check,...hash]).toString('hex')}
export function digest(value:string){return createHash('sha256').update(value).digest('hex')}
export function equal(a:string,b:string){return a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b))}
export async function authenticate(req:IncomingMessage,state:State):Promise<Actor>{
  const token=req.headers.authorization?.replace(/^Bearer /,'');if(!token)throw new Error('UNAUTHORIZED');
  if(token.startsWith('guest.')){
    const [,id,secret]=token.split('.');const p=state.profiles[id];
    if(!p?.guest||!p.active||p.expiresAt<=Date.now()||!secret||!equal(p.capabilityHash||'',digest(secret)))throw new Error('UNAUTHORIZED');
    return {id,kind:'user',verified:false};
  }
  if(token.startsWith('desk.')){
    const [,id,secret]=token.split('.');const p=state.profiles[id];
    if(!p?.active||p.guest||!secret||!['agency','volunteer','admin'].includes(p.role)||!equal(p.capabilityHash||'',digest(secret)))throw new Error('UNAUTHORIZED');
    return {id,kind:'user',verified:true,role:p.role,orgId:p.orgId};
  }
  const {payload}=await jwtVerify(token,jwks,{issuer,audience:process.env.OIDC_AUDIENCE||'relayaid',algorithms:['RS256']});
  if(!payload.sub||payload.email_verified!==true)throw new Error('UNAUTHORIZED');
  const id=identityFromClaims(issuer,payload.sub),p=state.profiles[id];if(p&&!p.active)throw new Error('UNAUTHORIZED');
  return {id,kind:'user',verified:true,role:id===process.env.AUTONOMY_ADMIN_IDENTITY?'admin':undefined};
}
export function outboxKey(ownerId:string){return createHmac('sha256',process.env.OUTBOX_MASTER_KEY!).update('outbox-v1:'+ownerId).digest('base64')}
