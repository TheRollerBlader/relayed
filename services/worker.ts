import {randomUUID} from 'node:crypto';
import {Database} from './db.ts';
import type {Actor} from '../shared/autonomy/contracts.ts';
const db=new Database('AGENT');
const actor:Actor={id:process.env.AGENT_IDENTITY!,kind:'agent'};
let stopping=false,abort:AbortController|undefined,failures=0;
const metrics={completed:0,recovered:0,failed:0};
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{stopping=true;abort?.abort();db.close()});
while(!stopping){
 try{
  const work=await db.work();failures=0;
  const now=Date.now();
  const job=Object.values(work.jobs).filter(j=>(j.state==='queued'||j.state==='running'&&j.leaseUntil<=now)&&j.nextAt<=now).sort((a,b)=>a.nextAt-b.nextAt)[0];
  if(job){
    abort=new AbortController();const fence=job.fence+1;if(job.state==='running')metrics.recovered++;
    await db.command(actor,{name:'job_claim',operationId:randomUUID(),body:{jobId:job.id}});
    let renewing=false;const interval=setInterval(()=>{if(renewing||abort?.signal.aborted)return;renewing=true;void db.command(actor,{name:'job_heartbeat',operationId:randomUUID(),body:{jobId:job.id,fence}}).catch(()=>abort?.abort()).finally(()=>{renewing=false})},5000);
    try{
      // Deterministic policy decisions run inside the database against current facts.
      // Language/vision output remains a reporter-reviewed draft, never authority.
      abort.signal.throwIfAborted();
      await db.command(actor,{name:'process_case',operationId:`process-${job.id}-${fence}`,expectedVersion:job.caseVersion,caseId:job.caseId,body:{jobId:job.id,fence}});
      abort.signal.throwIfAborted();await db.command(actor,{name:'job_finish',operationId:randomUUID(),body:{jobId:job.id,fence}});metrics.completed++;
    }catch{metrics.failed++}finally{clearInterval(interval);abort.abort();abort=undefined}
  }
  await db.command(actor,{name:'tick',operationId:randomUUID(),body:{}});
 }catch{failures++;console.warn(JSON.stringify({service:'worker',event:'reconnecting',failures,...metrics}))}
 if(!stopping)await new Promise(r=>setTimeout(r,Math.min(30000,1000*2**Math.min(failures,5))));
}
