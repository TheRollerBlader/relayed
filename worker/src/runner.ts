import { investigate } from './index.ts';
import { modelConfigured, type WorkerEnv } from './guard.ts';

export interface ClaimedJob {
  jobId: bigint;
  shelterId: string;
}

export interface JobWriter {
  append(input: {
    jobId: bigint;
    seq: number;
    toolName: string;
    inputSummary: string;
    resultRef: string;
    resultSummary: string;
    live: boolean;
  }): Promise<void>;
  finish(jobId: bigint, outcome: string, explanation: string, live: boolean): Promise<void>;
  execute(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export async function executeClaimedJob(
  env: WorkerEnv,
  job: ClaimedJob,
  writer: JobWriter,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<void> {
  const liveTools = modelConfigured(env);
  let seq = 0;
  const result = await investigate(
    { ...env, RELAYAID_SHELTER_ID: job.shelterId },
    async (name, args) => {
      const value = await writer.execute(name, args);
      seq += 1;
      const ref = `r${seq}`;
      await writer.append({
        jobId: job.jobId,
        seq,
        toolName: name,
        inputSummary: JSON.stringify(args).slice(0, 160),
        resultRef: ref,
        resultSummary: JSON.stringify(value).slice(0, 800),
        live: liveTools,
      });
      return { id: ref, value };
    },
    fetchImpl,
    45_000,
    signal,
  );
  const outcome = result.outcome === 'proposal' || result.outcome === 'rejected' || result.outcome === 'timeout' || result.outcome === 'fallback'
    ? result.outcome
    : 'failed';
  const live = liveTools && outcome !== 'timeout' && outcome !== 'fallback' && outcome !== 'failed';
  await writer.finish(job.jobId, outcome, result.explanation, live);
}
