import { Identity, Timestamp } from 'spacetimedb';
import { reviewModelResult } from './ground';
import { buildFallbackTrace } from './investigate';
import { fail, hostConfig, logEvent, requireMember, type Ctx } from './logic';

const CLIENT_ID = /^[A-Za-z0-9._:-]{8,80}$/;
const RATE_MICROS = 30_000_000n;
const LEASE_MICROS = 20_000_000n;
const OPEN = new Set(['queued', 'running']);

function jobByClient(ctx: Ctx, jobClientId: string) {
  return ctx.db.aiJob.jobClientId.find(jobClientId);
}

export function requestAiJob(ctx: Ctx, shelterId: string, jobClientId: string) {
  requireMember(ctx, shelterId, ['coordinator']);
  if (!CLIENT_ID.test(jobClientId)) fail('INVALID_INPUT');
  if (jobByClient(ctx, jobClientId)) return;
  const now = ctx.timestamp.microsSinceUnixEpoch;
  const recent = [...ctx.db.aiJob.iter()].some(
    job =>
      job.requester.equals(ctx.sender) &&
      job.shelterId === shelterId &&
      now >= job.createdAt.microsSinceUnixEpoch &&
      now - job.createdAt.microsSinceUnixEpoch < RATE_MICROS,
  );
  if (recent) fail('RATE_LIMIT');
  const snapshot = ctx.db.shelterVersion.shelterId.find(shelterId);
  if (!snapshot) fail('NOT_FOUND');
  if (hostConfig(ctx).aiMode === 'queue') {
    ctx.db.aiJob.insert({
      jobId: 0n,
      jobClientId,
      shelterId,
      requester: ctx.sender,
      state: 'queued',
      snapshotVersion: snapshot.snapshotVersion,
      leaseOwner: Identity.zero(),
      leaseExpiresAt: Timestamp.UNIX_EPOCH,
      explanation: '',
      rejectReason: '',
      live: false,
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
    });
    logEvent(ctx, shelterId, 'ai_job_queued', jobClientId, snapshot.snapshotVersion.toString(), '');
    return;
  }
  const built = buildFallbackTrace(ctx, shelterId);
  const job = ctx.db.aiJob.insert({
    jobId: 0n,
    jobClientId,
    shelterId,
    requester: ctx.sender,
    state: 'fallback',
    snapshotVersion: built.snapshotVersion,
    leaseOwner: Identity.zero(),
    leaseExpiresAt: Timestamp.UNIX_EPOCH,
    explanation: built.explanation,
    rejectReason: '',
    live: false,
    createdAt: ctx.timestamp,
    updatedAt: ctx.timestamp,
  });
  built.trace.forEach((item, index) => {
    ctx.db.aiJobEvent.insert({
      eventId: 0n,
      jobId: job.jobId,
      shelterId,
      seq: index + 1,
      toolName: item.tool,
      inputSummary: item.id,
      resultRef: item.id,
      resultSummary: JSON.stringify(item.result).slice(0, 800),
      live: false,
      at: ctx.timestamp,
    });
  });
  if (!ctx.db.modelRun.runId.find(jobClientId)) {
    ctx.db.modelRun.insert({
      runId: jobClientId,
      shelterId,
      correlationId: built.snapshotVersion.toString(),
      toolCalls: JSON.stringify(built.trace),
      outcome: 'fallback',
      explanation: built.explanation,
      startedAt: ctx.timestamp,
      endedAt: ctx.timestamp,
    });
  }
  logEvent(ctx, shelterId, 'ai_job_fallback', jobClientId, built.snapshotVersion.toString(), 'fallback');
}

function loadJob(ctx: Ctx, jobId: bigint) {
  const job = ctx.db.aiJob.jobId.find(jobId);
  if (!job) fail('NOT_FOUND');
  return job;
}

function leaseOpen(ctx: Ctx, job: ReturnType<typeof loadJob>) {
  return job.state === 'running' && job.leaseExpiresAt.microsSinceUnixEpoch <= ctx.timestamp.microsSinceUnixEpoch;
}

export function claimAiJob(ctx: Ctx, jobId: bigint) {
  const job = loadJob(ctx, jobId);
  const member = requireMember(ctx, job.shelterId, ['worker']);
  if (job.state === 'cancelled') fail('INVALID_TRANSITION');
  const expired = leaseOpen(ctx, job);
  if (job.state !== 'queued' && !expired) fail('INVALID_TRANSITION');
  const lease = ctx.db.aiJobLease.jobId.find(jobId);
  if (lease) ctx.db.aiJobLease.jobId.update({ jobId, fence: lease.fence + 1n });
  else ctx.db.aiJobLease.insert({ jobId, fence: 1n });
  // An expired attempt's partial trace cannot support the next attempt.
  for (const row of ctx.db.aiJobEvent.iter()) if (row.jobId === jobId) ctx.db.aiJobEvent.eventId.delete(row.eventId);
  ctx.db.aiJob.jobId.update({
    ...job,
    state: 'running',
    leaseOwner: member.identity,
    leaseExpiresAt: new Timestamp(ctx.timestamp.microsSinceUnixEpoch + LEASE_MICROS),
    updatedAt: ctx.timestamp,
  });
}

function requireLease(ctx: Ctx, jobId: bigint, fence: bigint) {
  if (ctx.db.aiJobLease.jobId.find(jobId)?.fence !== fence) fail('LEASE_LOST');
  const job = loadJob(ctx, jobId);
  const member = requireMember(ctx, job.shelterId, ['worker']);
  if (job.state === 'cancelled') fail('INVALID_TRANSITION');
  if (job.state !== 'running' || !job.leaseOwner.equals(member.identity)) fail('UNAUTHORIZED');
  if (job.leaseExpiresAt.microsSinceUnixEpoch <= ctx.timestamp.microsSinceUnixEpoch) fail('INVALID_TRANSITION');
  return job;
}

export function appendAiEvent(
  ctx: Ctx,
  jobId: bigint,
  fence: bigint,
  seq: number,
  toolName: string,
  inputSummary: string,
  resultRef: string,
  resultSummary: string,
  live: boolean,
) {
  const job = requireLease(ctx, jobId, fence);
  if (!Number.isInteger(seq) || seq < 1 || seq > 6) fail('INVALID_INPUT');
  if (toolName.length === 0 || toolName.length > 80 || resultRef.length === 0 || resultRef.length > 16) fail('INVALID_INPUT');
  const prior = [...ctx.db.aiJobEvent.iter()].find(item => item.jobId === jobId && item.seq === seq);
  if (prior) return;
  ctx.db.aiJobEvent.insert({
    eventId: 0n,
    jobId,
    shelterId: job.shelterId,
    seq,
    toolName,
    inputSummary: inputSummary.slice(0, 160),
    resultRef,
    resultSummary: resultSummary.slice(0, 800),
    live,
    at: ctx.timestamp,
  });
}

export function finishAiJob(ctx: Ctx, jobId: bigint, fence: bigint, outcome: string, explanation: string, live: boolean) {
  const job = requireLease(ctx, jobId, fence);
  if (explanation.length > 2000) fail('INVALID_INPUT');
  const liveSnapshot = ctx.db.shelterVersion.shelterId.find(job.shelterId)?.snapshotVersion;
  if (outcome === 'proposal' && liveSnapshot !== undefined && liveSnapshot !== job.snapshotVersion) {
    ctx.db.aiJob.jobId.update({
      ...job,
      state: 'stale',
      explanation,
      rejectReason: 'STALE_PLAN',
      live: false,
      updatedAt: ctx.timestamp,
    });
    logEvent(ctx, job.shelterId, 'ai_job_stale', job.jobClientId, job.snapshotVersion.toString(), '');
    return;
  }
  const events = [...ctx.db.aiJobEvent.iter()]
    .filter(item => item.jobId === jobId)
    .sort((a, b) => a.seq - b.seq);
  const extraShelters = events.flatMap(item => item.resultSummary.match(/\bshelter-[a-z0-9]+\b/g) ?? []);
  const reviewed = reviewModelResult({
    outcome,
    explanation,
    live,
    shelterId: job.shelterId,
    events,
    extraShelters,
  });
  ctx.db.aiJob.jobId.update({
    ...job,
    state: reviewed.outcome,
    explanation: reviewed.explanation,
    rejectReason: reviewed.rejectReason,
    live: reviewed.live,
    updatedAt: ctx.timestamp,
  });
  if (!ctx.db.modelRun.runId.find(job.jobClientId)) {
    ctx.db.modelRun.insert({
      runId: job.jobClientId,
      shelterId: job.shelterId,
      correlationId: job.snapshotVersion.toString(),
      toolCalls: JSON.stringify(events.map(item => ({ id: item.resultRef, tool: item.toolName }))),
      outcome: reviewed.outcome === 'proposal' ? 'proposal' : reviewed.outcome === 'timeout' ? 'timeout' : reviewed.outcome === 'fallback' ? 'fallback' : 'rejected',
      explanation: reviewed.explanation,
      startedAt: job.createdAt,
      endedAt: ctx.timestamp,
    });
  }
  logEvent(ctx, job.shelterId, 'ai_job_finished', job.jobClientId, reviewed.outcome, reviewed.rejectReason);
}

export function heartbeatAiJob(ctx: Ctx, jobId: bigint, fence: bigint) {
  const job = requireLease(ctx, jobId, fence);
  ctx.db.aiJob.jobId.update({ ...job, leaseExpiresAt: new Timestamp(ctx.timestamp.microsSinceUnixEpoch + LEASE_MICROS), updatedAt: ctx.timestamp });
}

export function cancelAiJob(ctx: Ctx, jobId: bigint) {
  const job = loadJob(ctx, jobId);
  requireMember(ctx, job.shelterId, ['coordinator']);
  if (!OPEN.has(job.state)) return;
  ctx.db.aiJob.jobId.update({
    ...job,
    state: 'cancelled',
    live: false,
    updatedAt: ctx.timestamp,
  });
  logEvent(ctx, job.shelterId, 'ai_job_cancelled', job.jobClientId, '', '');
}

export function coordinatorAiJobs(ctx: { db: Ctx['db']; sender: Identity }) {
  const member = ctx.db.member.identity.find(ctx.sender);
  if (!member || !member.active || member.role !== 'coordinator') return [];
  return [...ctx.db.aiJob.iter()].filter(job => job.shelterId === member.shelterId);
}

export function coordinatorAiEvents(ctx: { db: Ctx['db']; sender: Identity }) {
  const member = ctx.db.member.identity.find(ctx.sender);
  if (!member || !member.active || member.role !== 'coordinator') return [];
  return [...ctx.db.aiJobEvent.iter()].filter(item => item.shelterId === member.shelterId);
}

export function workerAiJobs(ctx: { db: Ctx['db']; sender: Identity }) {
  const member = ctx.db.member.identity.find(ctx.sender);
  if (!member || member.role !== 'worker' || !member.active) return [];
  return [...ctx.db.aiJob.iter()]
    .filter(job => job.shelterId === member.shelterId && (job.state === 'queued' || job.state === 'running'))
    .map(job => ({
      jobId: job.jobId,
      shelterId: job.shelterId,
      state: job.state,
      snapshotVersion: job.snapshotVersion,
      leaseExpiresAt: job.leaseExpiresAt,
      leaseOwner: job.leaseOwner,
      fence: ctx.db.aiJobLease.jobId.find(job.jobId)?.fence ?? 0n,
    }));
}

export function workerTransferOffers(ctx: { db: Ctx['db']; sender: Identity }) {
  const member = ctx.db.member.identity.find(ctx.sender);
  if (!member || member.role !== 'worker' || !member.active) return [];
  const grouped = new Map<string, { kind: string; destShelterId: string; state: string; quantity: number; offerCount: number }>();
  for (const row of ctx.db.transfer.iter()) {
    if (row.sourceShelterId !== member.shelterId && row.destShelterId !== member.shelterId) continue;
    const key = `${row.kind}:${row.destShelterId}:${row.state}`;
    const current = grouped.get(key) ?? {
      kind: row.kind,
      destShelterId: row.destShelterId,
      state: row.state,
      quantity: 0,
      offerCount: 0,
    };
    current.quantity += row.quantityOffered || row.quantityRequested;
    current.offerCount += 1;
    grouped.set(key, current);
  }
  return [...grouped.entries()].map(([rowId, row]) => ({ rowId, ...row }));
}

export function workerVolunteerCounts(ctx: { db: Ctx['db']; sender: Identity }) {
  const member = ctx.db.member.identity.find(ctx.sender);
  if (!member || member.role !== 'worker' || !member.active) return [];
  const profiles = [...ctx.db.volunteerProfile.iter()].filter(
    profile => profile.shelterId === member.shelterId && profile.available,
  );
  return [
    {
      shelterId: member.shelterId,
      canCarryWater: profiles.filter(profile => profile.canCarryWater).length,
      chargerEscort: profiles.filter(profile => profile.chargerEscort).length,
    },
  ];
}
