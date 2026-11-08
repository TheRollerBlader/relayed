import { DbConnection } from '../../src/module_bindings/index.ts';
import { applyWhatIf, solve, type SolverRequest, type SolverResource } from '../../spacetimedb/src/solver.ts';
import type { WorkerEnv } from './guard.ts';
import { executeClaimedJob } from './runner.ts';

type Conn = DbConnection;

function list<T>(rows: Iterable<T>): T[] {
  return [...rows];
}

function executeTool(conn: Conn, shelterId: string, snapshotVersion: string, name: string, args: Record<string, unknown>) {
  if (typeof args.shelter_id === 'string' && args.shelter_id !== shelterId) return { error: 'WRONG_SHELTER' };
  const requests = list(conn.db.workerRequests.iter());
  const resources = list(conn.db.workerResources.iter());
  if (name === 'list_stalled_requests') {
    return requests
      .filter((row) => row.state === 'acknowledged' || row.state === 'received')
      .map((row) => ({ id: row.requestPk.toString(), kind: row.kind, quantity: row.quantity, state: row.state }));
  }
  if (name === 'list_resources') {
    return resources.map((row) => ({
      id: row.resourceId,
      kind: row.kind,
      available: row.available,
      reserved: row.reserved,
    }));
  }
  if (name === 'list_volunteer_availability') {
    const counts = list(conn.db.workerVolunteerCounts.iter())[0];
    return { can_carry_water: counts?.canCarryWater ?? 0, charger_escort: counts?.chargerEscort ?? 0 };
  }
  if (name === 'list_transfer_offers' || name === 'read_transfer_possibilities') {
    return list(conn.db.workerTransferOffers.iter()).map((row) => ({
      kind: row.kind,
      dest: row.destShelterId,
      state: row.state,
      quantity: row.quantity,
      offers: row.offerCount,
    }));
  }
  if (name === 'run_plan' || name === 'run_what_if') {
    const solverRequests: SolverRequest[] = requests.filter(row => row.kind === 'water' || row.kind === 'charging').map((row) => ({
      requestPk: row.requestPk,
      kind: row.kind === 'charging' ? 'charging' : 'water',
      needsAccessible: row.needs === 'accessible_slot',
      quantity: row.quantity,
      receivedAtMicros: row.receivedAt.microsSinceUnixEpoch,
      humanPriority: row.humanPriority,
      state: row.state,
    }));
    let stock: SolverResource[] = resources.map((row) => ({
      resourceId: row.resourceId,
      kind: row.kind === 'charger_slot' ? 'charger_slot' : 'water_stock',
      accessible: row.accessible,
      available: row.available,
    }));
    if (name === 'run_what_if' && args.change === 'transfer' && typeof args.count === 'number') {
      stock = applyWhatIf(stock, [{ kind: 'water_stock', accessible: false, count: args.count }]);
    }
    const strategy = args.strategy === 'fcfs' ? 'fcfs' : 'suitability';
    const plan = solve(strategy, solverRequests, stock, { nowMicros: BigInt(Date.now()) * 1000n });
    return {
      served: plan.assignments.length,
      method: plan.method,
      snapshot: snapshotVersion,
      hypothetical: name === 'run_what_if',
    };
  }
  if (name === 'submit_bottleneck_proposal') return { accepted: true };
  return { error: 'UNKNOWN_TOOL' };
}

export async function runWorker(env: WorkerEnv = process.env): Promise<void> {
  const uri = env.SPACETIME_URI;
  const token = env.SPACETIME_TOKEN;
  const database = env.SPACETIME_DB_NAME || 'relayaid-demo';
  if (!uri || !token) throw new Error('SPACETIME_URI and SPACETIME_TOKEN are required');
  let stopping = false;
  let current: Conn | undefined;
  let active: AbortController | undefined;
  const stop = () => { stopping = true; active?.abort(); current?.disconnect(); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  let failures = 0;
  while (!stopping) {
    let disconnected = false;
    try {
      const conn = await new Promise<Conn>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('CONNECT_TIMEOUT')), 10_000);
        current = DbConnection.builder().withUri(uri).withDatabaseName(database).withToken(token)
          .onConnect(connection => { clearTimeout(timer); resolve(connection); })
          .onConnectError(() => { clearTimeout(timer); reject(new Error('CONNECT_FAILED')); })
          .onDisconnect(() => { disconnected = true; active?.abort(); }).build();
      });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('SUBSCRIPTION_TIMEOUT')), 10_000);
        conn.subscriptionBuilder().onApplied(() => { clearTimeout(timer); resolve(); })
          .onError(() => { clearTimeout(timer); reject(new Error('SUBSCRIPTION_FAILED')); })
          .subscribe(['SELECT * FROM worker_ai_jobs', 'SELECT * FROM worker_requests', 'SELECT * FROM worker_resources', 'SELECT * FROM worker_transfer_offers', 'SELECT * FROM worker_volunteer_counts']);
      });
      failures = 0;
      // One active job per process; replica concurrency is fenced in the reducer.
      while (!stopping && !disconnected) {
        const now = BigInt(Date.now()) * 1000n;
        const job = list(conn.db.workerAiJobs.iter()).find(row => row.state === 'queued' || row.state === 'running' && row.leaseExpiresAt.microsSinceUnixEpoch <= now);
        if (!job) { await new Promise(resolve => setTimeout(resolve, 1000)); continue; }
        const fence = job.fence + 1n;
        active = new AbortController();
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        let renewing = false;
        try {
          await conn.reducers.claimAiJob({ jobId: job.jobId });
          heartbeat = setInterval(() => {
            if (renewing) return;
            renewing = true;
            void conn.reducers.heartbeatAiJob({jobId:job.jobId,fence})
              .catch(() => active?.abort()).finally(() => {renewing=false});
          }, 5000);
          const runSignal = active.signal;
          await executeClaimedJob(env, { jobId: job.jobId, shelterId: job.shelterId }, {
            async append(input) { runSignal.throwIfAborted(); await conn.reducers.appendAiEvent({...input, fence}); },
            async finish(jobId, outcome, explanation, live) { runSignal.throwIfAborted(); await conn.reducers.finishAiJob({jobId,fence,outcome,explanation,live}); },
            async execute(name,args) { runSignal.throwIfAborted(); return executeTool(conn,job.shelterId,job.snapshotVersion.toString(),name,args); },
          }, fetch, runSignal);
        } catch { console.warn(JSON.stringify({event:'worker_attempt_failed', retryable:true})); }
        finally { if (heartbeat) clearInterval(heartbeat); active?.abort(); active=undefined; }
      }
    } catch { console.warn(JSON.stringify({event:'worker_reconnecting',attempt:++failures})); }
    finally { current?.disconnect(); current=undefined; }
    if (!stopping) await new Promise(resolve=>setTimeout(resolve,Math.min(30_000,500*2**Math.min(failures,6))));
  }
  process.removeListener('SIGTERM',stop); process.removeListener('SIGINT',stop);
}
