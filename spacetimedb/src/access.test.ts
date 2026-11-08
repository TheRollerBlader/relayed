import assert from 'node:assert/strict';
import { test } from 'vitest';
import { ConnectionId, Identity, TimeDuration, Timestamp } from 'spacetimedb';
import { SenderError } from 'spacetimedb/server';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import * as module from './index.ts';
import {
  assertSession,
  claimDemoRole,
  completeAssignment,
  grantMembership,
  hostConfig,
  myRequests,
  seedDemo,
  SHELTER_A,
  SHELTER_B,
  type Ctx,
} from './logic.ts';
import { acceptInvite, createInvite } from './invites.ts';
import { appendAiEvent, claimAiJob, finishAiJob, requestAiJob } from './jobs.ts';
import { checkInTask, coordinatorLocations, myProgress, stopTaskLocation, updateTaskLocation } from './location.ts';
import spacetimedb from './schema.ts';

const sender = new Identity('ab'.repeat(32));
const harness = createModuleTestHarness(spacetimedb, module, { moduleIdentity: sender });
const internal = TestAuth.internal();

function tx(body: (ctx: Ctx) => void) {
  harness.withReducerTx(internal, body);
}

function codeOf(body: (ctx: Ctx) => void): string {
  try {
    tx(body);
  } catch (error) {
    if (error instanceof SenderError) return error.message;
    throw error;
  }
  return '';
}

function codeAs(auth: TestAuth, body: (ctx: Ctx) => void): string {
  try {
    harness.withReducerTx(auth, body);
  } catch (error) {
    if (error instanceof SenderError) return error.message;
    throw error;
  }
  return '';
}

function jwt(sub: string, iss = 'https://auth.spacetimedb.com/oidc', aud: string | string[] = 'relay-aid', connection = 1n) {
  return TestAuth.fromJwtPayload(JSON.stringify({ sub, iss, aud }), new ConnectionId(connection));
}

function setHost(patch: Partial<{ authMode: string; aiMode: string; oidcIssuer: string; oidcAudience: string; bootstrapAdminSub: string }>) {
  tx(ctx => {
    const row = ctx.db.moduleConfig.configId.find('host');
    if (!row) throw new Error('missing config');
    ctx.db.moduleConfig.configId.update({ ...row, ...patch });
  });
}

test('demo claim still works and real auth rejects anonymous sessions', () => {
  tx(seedDemo);
  tx(ctx => claimDemoRole(ctx, SHELTER_A, 'coordinator', 'Desk lead'));
  assert.equal(hostConfig({ db: harness.db }).authMode, 'demo');
  setHost({
    authMode: 'real',
    oidcIssuer: 'https://auth.spacetimedb.com/oidc',
    oidcAudience: 'relay-aid',
    bootstrapAdminSub: 'admin-1',
  });
  assert.equal(codeOf(ctx => claimDemoRole(ctx, SHELTER_B, 'coordinator', 'Desk lead')), 'UNAUTHORIZED');
  assert.equal(codeOf(ctx => assertSession(ctx)), 'UNAUTHORIZED');
  assert.equal(
    codeAs(jwt('admin-1', 'https://evil.example'), ctx => assertSession(ctx)),
    'UNAUTHORIZED',
  );
  assert.equal(codeAs(jwt('admin-1', 'https://auth.spacetimedb.com/oidc', 'other-app'), ctx => assertSession(ctx)), 'UNAUTHORIZED');
  assert.equal(codeAs(jwt('admin-1'), ctx => assertSession(ctx)), '');
  const resident = new Identity('cd'.repeat(32));
  assert.equal(
    codeAs(jwt('admin-1', 'https://auth.spacetimedb.com/oidc', 'relay-aid', 9n), ctx =>
      grantMembership(ctx, resident, SHELTER_A, 'resident', 'Jordan Hale'),
    ),
    '',
  );
  assert.equal(
    codeAs(jwt('stranger'), ctx => grantMembership(ctx, resident, SHELTER_A, 'coordinator', 'Desk lead')),
    'UNAUTHORIZED',
  );
  setHost({ authMode: 'demo', aiMode: 'inline', bootstrapAdminSub: '' });
});

test('invites expire and never grant a coordinator', () => {
  assert.equal(
    codeOf(ctx => createInvite(ctx, 'invite-coord1', SHELTER_A, 'coordinator', '', 5_000_000n, 1)),
    'INVALID_INPUT',
  );
  tx(ctx => createInvite(ctx, 'invite-expire', SHELTER_A, 'resident', '', 1_000_000n, 1));
  harness.clock.advance(new TimeDuration(2_000_000n));
  assert.equal(
    codeAs(jwt('late-resident', 'https://auth.spacetimedb.com/oidc', 'relay-aid', 11n), ctx => acceptInvite(ctx, 'invite-expire')),
    'INVALID_INPUT',
  );
  const later = harness.clock.now().microsSinceUnixEpoch + 60_000_000n;
  tx(ctx => createInvite(ctx, 'invite-once01', SHELTER_A, 'volunteer', '', later, 1));
  assert.equal(codeAs(jwt('volunteer-1', 'https://auth.spacetimedb.com/oidc', 'relay-aid', 12n), ctx => acceptInvite(ctx, 'invite-once01')), '');
  assert.equal(codeAs(jwt('volunteer-2', 'https://auth.spacetimedb.com/oidc', 'relay-aid', 13n), ctx => acceptInvite(ctx, 'invite-once01')), 'NOT_FOUND');
});

test('ai jobs are idempotent, leased once, and reject invented evidence', () => {
  setHost({ aiMode: 'inline' });
  tx(ctx => requestAiJob(ctx, SHELTER_A, 'job-inline-1'));
  tx(ctx => requestAiJob(ctx, SHELTER_A, 'job-inline-1'));
  const inline = harness.db.aiJob.iter().find(job => job.jobClientId === 'job-inline-1');
  assert.equal(inline?.state, 'fallback');
  assert.equal(inline?.live, false);
  assert.match(inline?.explanation ?? '', /Model unavailable; deterministic plan only/);
  assert.equal([...harness.db.aiJob.iter()].filter(job => job.jobClientId === 'job-inline-1').length, 1);

  harness.clock.advance(new TimeDuration(31_000_000n));
  setHost({ aiMode: 'queue' });
  tx(ctx => requestAiJob(ctx, SHELTER_A, 'job-queue-001'));
  assert.equal(codeOf(ctx => requestAiJob(ctx, SHELTER_A, 'job-queue-002')), 'RATE_LIMIT');
  harness.clock.advance(new TimeDuration(31_000_000n));
  tx(ctx => requestAiJob(ctx, SHELTER_A, 'job-queue-002'));
  const queued = [...harness.db.aiJob.iter()].find(job => job.jobClientId === 'job-queue-001');
  assert.equal(queued?.state, 'queued');
  assert.ok(queued);
  const workerA = jwt('worker-a', 'https://auth.spacetimedb.com/oidc', 'relay-aid', 21n);
  const workerB = jwt('worker-b', 'https://auth.spacetimedb.com/oidc', 'relay-aid', 22n);
  harness.withReducerTx(workerA, ctx => {
    ctx.db.member.insert({
      identity: ctx.sender,
      shelterId: SHELTER_A,
      role: 'worker',
      displayLabel: 'Worker A',
      grantedBy: ctx.sender,
      active: true,
    });
    claimAiJob(ctx, queued.jobId);
    appendAiEvent(ctx, queued.jobId, 1n, 1, 'run_plan', 'shelter-a', 'r1', '{"served":2,"dest":"shelter-b"}', true);
  });
  harness.clock.advance(new TimeDuration(21_000_000n));
  harness.withReducerTx(workerB, ctx => {
    ctx.db.member.insert({
      identity: ctx.sender,
      shelterId: SHELTER_A,
      role: 'worker',
      displayLabel: 'Worker B',
      grantedBy: ctx.sender,
      active: true,
    });
    claimAiJob(ctx, queued.jobId);
  });
  assert.equal(
    codeAs(workerA, ctx => finishAiJob(ctx, queued.jobId, 1n, 'proposal', 'served 2 at shelter-b r1', true)),
    'LEASE_LOST',
  );
  harness.withReducerTx(workerB, ctx => {
    appendAiEvent(ctx, queued.jobId, 2n, 1, 'run_plan', 'shelter-a', 'r1', '{"served":2,"dest":"shelter-b"}', true);
    finishAiJob(ctx, queued.jobId, 2n, 'proposal', 'served 99 at shelter-c r1', true);
  });
  const rejected = harness.db.aiJob.jobId.find(queued.jobId);
  assert.equal(rejected?.state, 'rejected');
  assert.equal(rejected?.live, false);
  assert.equal(rejected?.rejectReason === 'INVENTED_NUMBER' || rejected?.rejectReason === 'DESTINATION', true);

  harness.clock.advance(new TimeDuration(31_000_000n));
  tx(ctx => requestAiJob(ctx, SHELTER_A, 'job-queue-003'));
  const whatIf = [...harness.db.aiJob.iter()].find(job => job.jobClientId === 'job-queue-003');
  assert.ok(whatIf);
  harness.withReducerTx(workerB, ctx => {
    claimAiJob(ctx, whatIf.jobId);
    appendAiEvent(ctx, whatIf.jobId, 1n, 1, 'run_what_if', 'transfer', 'r1', '{"served":2,"hypothetical":true}', true);
    finishAiJob(ctx, whatIf.jobId, 1n, 'proposal', 'served 2 r1', true);
  });
  assert.equal(harness.db.aiJob.jobId.find(whatIf.jobId)?.rejectReason, 'HYPOTHETICAL');

  harness.clock.advance(new TimeDuration(31_000_000n));
  tx(ctx => requestAiJob(ctx, SHELTER_A, 'job-queue-004'));
  const stale = [...harness.db.aiJob.iter()].find(job => job.jobClientId === 'job-queue-004');
  assert.ok(stale);
  tx(ctx => {
    const version = ctx.db.shelterVersion.shelterId.find(SHELTER_A);
    if (!version) throw new Error('missing version');
    ctx.db.shelterVersion.shelterId.update({ ...version, snapshotVersion: version.snapshotVersion + 1n });
  });
  harness.withReducerTx(workerB, ctx => {
    claimAiJob(ctx, stale.jobId);
    finishAiJob(ctx, stale.jobId, 1n, 'proposal', 'served 2 r1', true);
  });
  assert.equal(harness.db.aiJob.jobId.find(stale.jobId)?.state, 'stale');
  setHost({ aiMode: 'inline' });
});

test('location sharing stops, expires consent, and hides coordinates from residents', () => {
  const volunteer = jwt('volunteer-9', 'https://auth.spacetimedb.com/oidc', 'relay-aid', 31n);
  const other = jwt('volunteer-8', 'https://auth.spacetimedb.com/oidc', 'relay-aid', 32n);
  const resident = jwt('resident-9', 'https://auth.spacetimedb.com/oidc', 'relay-aid', 33n);
  let assignmentId = 0n;
  let requestPk = 0n;
  harness.withReducerTx(volunteer, ctx => {
    ctx.db.member.insert({
      identity: ctx.sender,
      shelterId: SHELTER_A,
      role: 'volunteer',
      displayLabel: 'Volunteer',
      grantedBy: ctx.sender,
      active: true,
    });
    const request = ctx.db.helpRequest.insert({
      requestPk: 0n,
      shelterId: SHELTER_A,
      clientRequestId: 'loc-request-1',
      idempotencyKey: 'loc-request-1',
      residentIdentity: Identity.zero(),
      kind: 'water',
      needs: '',
      quantity: 1,
      payloadHash: 'water||1',
      clientCreatedAt: 'device',
      receivedAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
      serveBy: Timestamp.UNIX_EPOCH,
      state: 'assigned',
      stateVersion: 1n,
      humanPriority: 0,
      priorityReason: '',
      cancelReason: '',
      confirmation: '',
      fulfilledUnits: 0,
      backorderOf: 0n,
    });
    requestPk = request.requestPk;
    const assignment = ctx.db.assignment.insert({
      assignmentId: 0n,
      shelterId: SHELTER_A,
      planId: 0n,
      requestPk: request.requestPk,
      resourceId: 'water-a',
      units: 1,
      volunteerSet: true,
      volunteerIdentity: ctx.sender,
      state: 'reserved',
      dispatchState: 'accepted',
      dispatchVersion: 1n,
      dueAt: Timestamp.UNIX_EPOCH,
      declineReason: '',
      openedAt: ctx.timestamp,
      deliveredAt: Timestamp.UNIX_EPOCH,
    });
    assignmentId = assignment.assignmentId;
    updateTaskLocation(ctx, assignmentId, 0n, 1n, 32.78, -96.8, 12, 'device');
  });
  assert.equal(
    codeAs(other, ctx => {
      ctx.db.member.insert({
        identity: ctx.sender,
        shelterId: SHELTER_A,
        role: 'volunteer',
        displayLabel: 'Other',
        grantedBy: ctx.sender,
        active: true,
      });
      updateTaskLocation(ctx, assignmentId, 0n, 2n, 32.78, -96.8, 12, 'device');
    }),
    'UNAUTHORIZED',
  );
  harness.clock.advance(new TimeDuration(6_000_000n));
  assert.equal(
    codeAs(volunteer, ctx => updateTaskLocation(ctx, assignmentId, 0n, 1n, 32.79, -96.8, 8, 'device')),
    'INVALID_INPUT',
  );
  harness.withReducerTx(volunteer, ctx => stopTaskLocation(ctx, assignmentId, 0n));
  assert.equal(coordinatorLocations({ db: harness.db, sender }).some(row => row.subjectKey === `a:${assignmentId}`), false);
  assert.equal(
    codeAs(volunteer, ctx => updateTaskLocation(ctx, assignmentId, 0n, 3n, 32.79, -96.8, 8, 'device')),
    'INVALID_TRANSITION',
  );
  harness.withReducerTx(volunteer, ctx => checkInTask(ctx, assignmentId, 0n, 'on_the_way'));
  harness.withReducerTx(resident, ctx => {
    ctx.db.member.insert({
      identity: ctx.sender,
      shelterId: SHELTER_A,
      role: 'resident',
      displayLabel: 'Resident',
      grantedBy: ctx.sender,
      active: true,
    });
    const request = ctx.db.helpRequest.requestPk.find(requestPk);
    if (!request) throw new Error('missing request');
    ctx.db.helpRequest.requestPk.update({ ...request, residentIdentity: ctx.sender });
  });
  const progress = harness.withReducerTx(resident, ctx => myProgress(ctx));
  assert.equal(progress[0]?.sentence, 'Volunteer is on the way');
  assert.equal(Object.keys(progress[0] ?? {}).includes('lat'), false);
  const south = new Identity('ef'.repeat(32));
  tx(ctx => {
    ctx.db.member.insert({
      identity: south,
      shelterId: SHELTER_B,
      role: 'coordinator',
      displayLabel: 'South',
      grantedBy: sender,
      active: true,
    });
  });
  assert.equal(coordinatorLocations({ db: harness.db, sender: south }).some(row => row.subjectKey === `a:${assignmentId}`), false);
  assert.equal(myRequests({ db: harness.db, sender: south, timestamp: Timestamp.UNIX_EPOCH }).length, 0);
  const water = harness.db.resource.resourceId.find('water-a');
  assert.ok(water);
  tx(ctx => {
    ctx.db.resource.resourceId.update({ ...water, reserved: water.reserved + 1 });
  });
  harness.withReducerTx(volunteer, ctx => completeAssignment(ctx, assignmentId));
  assert.equal(harness.db.taskLocationLatest.subjectKey.find(`a:${assignmentId}`), null);
});
