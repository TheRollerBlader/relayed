import type {Database} from '../db.ts';
import type {Actor} from '../../shared/autonomy/contracts.ts';

const agent: Actor = {id:'orchestrator', kind:'agent'};
let busy = false;

/** Claims queued case jobs and applies the deterministic policy. The model never writes. */
export function startOrchestrator(db: Database) {
  return setInterval(() => void step(db), 1000);
}

async function step(db: Database) {
  if (busy) return;
  busy = true;
  try {
    const now = Date.now();
    const state = await db.snapshot();
    const due = Object.values(state.jobs).filter(job => job.nextAt <= now && (job.state === 'queued' || (job.state === 'running' && job.leaseUntil <= now))).slice(0, 4);
    for (const job of due) {
      try {
        const claimed = await db.command(agent, {name:'job_claim', operationId:`claim-${job.id}-${job.attempts + 1}`, body:{jobId:job.id}}) as {fence:number};
        const fresh = await db.snapshot();
        const current = fresh.cases[job.caseId];
        if (!current) continue;
        await db.command(agent, {name:'process_case', operationId:`proc-${job.id}-v${current.version}`, expectedVersion:current.version, caseId:current.id, body:{jobId:job.id, fence:claimed.fence}});
        await db.command(agent, {name:'job_finish', operationId:`done-${job.id}-f${claimed.fence}`, body:{jobId:job.id, fence:claimed.fence}});
      } catch { /* Leave the lease to expire and retry. Do not log report text. */ }
    }
    await db.command(agent, {name:'tick', operationId:`tick-${now}`, body:{}});
  } catch { /* Health reports database availability. */ }
  finally { busy = false; }
}
