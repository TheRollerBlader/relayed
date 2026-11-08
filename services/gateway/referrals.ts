import {randomUUID} from 'node:crypto';
import type {Database} from '../db.ts';
import {sign} from '../http.ts';
const endpoint=process.env.SANDBOX_URL||'http://127.0.0.1:4200';
if(!['127.0.0.1','localhost','sandbox'].includes(new URL(endpoint).hostname))throw new Error('SANDBOX_ENDPOINT_REQUIRED');
export function deliverReferrals(db:Database){
 let busy=false;
 return setInterval(async()=>{
  if(busy)return;busy=true;
  try{
   const s=await db.snapshot();
   for(const r of Object.values(s.referrals).filter(r=>!r.retired&&['queued','sent'].includes(r.state)&&r.nextAt<=Date.now()&&r.attempts<3).slice(0,4)){
    const c=s.cases[r.caseId],service=s.services[r.serviceId];
    // Only a coarse, opaque coverage label is released before acceptance.
    const body=JSON.stringify({id:r.id,correlationId:r.id,category:c.category,priority:c.priority,coverageArea:`coverage:${service.id}`,service:{id:service.id,orgId:service.orgId,mode:service.mode,available:service.available,capacity:service.capacity,autoAccept:service.autoAccept,delayMs:service.delayMs}});
    // Record the attempt first; restart recovery reuses the same correlation ID.
    await db.command({id:'gateway',kind:'gateway'},{name:'referral_sent',operationId:`send-${r.id}-${r.attempts+1}`,expectedVersion:r.version,body:{referralId:r.id}});
    const stamp=String(Date.now());
    await fetch(endpoint+'/referrals',{method:'POST',headers:{'content-type':'application/json','x-relay-timestamp':stamp,'x-relay-signature':sign(body,stamp,process.env.REFERRAL_SECRET!)},body,signal:AbortSignal.timeout(5000)}).catch(()=>{});
   }
  }catch{/* Health exposes connectivity; never log report content. */}finally{busy=false}
 },1000);
}
