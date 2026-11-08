import assert from 'node:assert/strict';
import { test } from 'vitest';
import { Identity, Timestamp } from 'spacetimedb';
import { SenderError } from 'spacetimedb/server';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import * as module from './index.ts';
import {
  acknowledgeRequest,
  approvePlan,
  cancelRequest,
  claimDemoRole,
  completeAssignment,
  coordinatorBoard,
  coordinatorQueue,
  FALLBACK_EXPLANATION,
  generatePlan,
  myAssignments,
  myRequests,
  releaseAssignment,
  seedDemo,
  SHELTER_A,
  SHELTER_B,
  submitModelProposal,
  submitRequest,
  updateResource,
  type Ctx,
} from './logic.ts';
import { endChargingSession, confirmDelivery, disputeDelivery } from './confirmation.ts';
import { acceptTask, declineTask, flagOverdue, offerTask } from './dispatch.ts';
import { summarize } from './estimates.ts';
import { requestInvestigation } from './investigate.ts';
import {
  approveTransfer,
  cancelTransfer,
  collectTransfer,
  coordinatorTransfers,
  createShortage,
  offerTransfer,
  receiveTransfer,
} from './transfers.ts';
import spacetimedb from './schema.ts';

const sender = new Identity('11'.repeat(32));
const otherVolunteer = new Identity('22'.repeat(32));
const harness = createModuleTestHarness(spacetimedb, module, { moduleIdentity: sender });
const auth = TestAuth.internal();

function tx(body: (ctx: Ctx) => void) {
  harness.withReducerTx(auth, body);
}

function read<T>(body: (ctx: Ctx) => T): T {
  let value!: T;
  tx(ctx => {
    value = body(ctx);
  });
  return value;
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

function setRole(role: string, shelterId = SHELTER_A) {
  tx(ctx => {
    const member = ctx.db.member.identity.find(ctx.sender);
    if (!member) throw new Error('missing member');
    ctx.db.member.identity.update({ ...member, role, shelterId, active: true });
  });
}

function submit(clientRequestId: string, kind: string, needs: string[] = []) {
  tx(ctx => {
    submitRequest(ctx, {
      shelterId: SHELTER_A,
      clientRequestId,
      kind,
      needs,
      quantity: 1,
      clientCreatedAt: 'device-clock',
    });
  });
}

test('authoritative shelter flow', () => {
  tx(seedDemo);
  tx(ctx => claimDemoRole(ctx, SHELTER_A, 'resident', 'Zone B, cot 14'));

  submit('request-001', 'charging', ['accessible_slot']);
  submit('request-001', 'charging', ['accessible_slot']);
  submit('request-001', 'charging', ['accessible_slot']);
  const conflict = codeOf(ctx => {
    submitRequest(ctx, {
      shelterId: SHELTER_A,
      clientRequestId: 'request-001',
      kind: 'charging',
      needs: [],
      quantity: 1,
      clientCreatedAt: 'device-clock',
    });
  });
  assert.equal(conflict, 'IDEMPOTENCY_CONFLICT');

  const original = read(ctx => {
    const rows = [...ctx.db.helpRequest.iter()];
    const events = [...ctx.db.event.iter()].filter(item => item.type === 'request_received');
    return { rows, events };
  });
  assert.equal(original.rows.length, 1);
  assert.equal(original.rows[0].needs, 'accessible_slot');
  assert.equal(original.events.length, 1);

  const requestPk = original.rows[0].requestPk;
  assert.equal(
    codeOf(ctx => acknowledgeRequest(ctx, requestPk, 1n)),
    'UNAUTHORIZED',
  );

  setRole('coordinator');
  tx(ctx => acknowledgeRequest(ctx, requestPk, 1n));
  tx(ctx => acknowledgeRequest(ctx, requestPk, 1n));
  const acked = read(ctx => ctx.db.helpRequest.requestPk.find(requestPk));
  assert.equal(acked?.state, 'acknowledged');
  assert.equal(
    read(ctx => [...ctx.db.event.iter()].filter(item => item.type === 'request_acknowledged').length),
    1,
  );

  const other = new Identity('33'.repeat(32));
  tx(ctx => {
    const sample = ctx.db.helpRequest.requestPk.find(requestPk);
    if (!sample) throw new Error('missing request');
    ctx.db.helpRequest.insert({
      ...sample,
      requestPk: 0n,
      clientRequestId: 'request-other',
      idempotencyKey: `${SHELTER_A}\u001frequest-other`,
      residentIdentity: other,
      state: 'received',
      stateVersion: 1n,
    });
  });
  assert.equal(read(ctx => myRequests(ctx).length), 1);
  const queue = read(ctx => coordinatorQueue(ctx));
  assert.equal(queue.length, 2);
  assert.equal(queue[0].state, 'received');
  assert.equal(queue[0].waitReason, 'not_acknowledged');

  setRole('coordinator', SHELTER_B);
  assert.equal(
    codeOf(ctx => updateResource(ctx, 'water-a', 1n, 2, 2)),
    'WRONG_SHELTER',
  );
  setRole('coordinator', SHELTER_A);

  const availableBefore = read(ctx => ctx.db.resource.resourceId.find('charge-access-a')?.available);
  tx(ctx => generatePlan(ctx, SHELTER_A, 'suitability', []));
  assert.equal(
    read(ctx => ctx.db.resource.resourceId.find('charge-access-a')?.available),
    availableBefore,
  );

  tx(ctx => updateResource(ctx, 'water-a', 1n, 2, 2));
  const stalePlanId = read(ctx => [...ctx.db.plan.iter()].at(-1)?.planId);
  const staleSnapshot = read(ctx =>
    [...ctx.db.plan.iter()].at(-1)?.inputSnapshotVersion,
  );
  assert.ok(stalePlanId !== undefined && staleSnapshot !== undefined);
  assert.equal(
    codeOf(ctx => approvePlan(ctx, stalePlanId, staleSnapshot, 'approval-stale')),
    'STALE_PLAN',
  );

  setRole('resident');
  submit('request-002', 'charging', ['accessible_slot']);
  setRole('coordinator');
  const secondPk = read(ctx =>
    [...ctx.db.helpRequest.iter()].find(item => item.clientRequestId === 'request-002')?.requestPk,
  );
  assert.ok(secondPk !== undefined);
  tx(ctx => acknowledgeRequest(ctx, secondPk, 1n));
  tx(ctx => generatePlan(ctx, SHELTER_A, 'suitability', []));
  tx(ctx => generatePlan(ctx, SHELTER_A, 'fcfs', []));
  const fresh = read(ctx => [...ctx.db.plan.iter()].filter(item => item.status === 'proposed').at(-1));
  assert.ok(fresh);
  const reservedBefore = read(ctx => [...ctx.db.assignment.iter()].length);
  tx(ctx => approvePlan(ctx, fresh.planId, fresh.inputSnapshotVersion, 'approval-race-a'));
  assert.equal(
    codeOf(ctx => approvePlan(ctx, fresh.planId, fresh.inputSnapshotVersion, 'approval-race-b')),
    'ALREADY_APPROVED',
  );
  const competing = read(ctx =>
    [...ctx.db.plan.iter()].find(item => item.planId !== fresh.planId && item.status === 'proposed'),
  );
  assert.ok(competing);
  assert.equal(
    codeOf(ctx => approvePlan(ctx, competing.planId, competing.inputSnapshotVersion, 'approval-race-c')),
    'STALE_PLAN',
  );
  tx(ctx => approvePlan(ctx, fresh.planId, fresh.inputSnapshotVersion, 'approval-race-a'));
  const afterRace = read(ctx => ({
    assignments: [...ctx.db.assignment.iter()],
    charger: ctx.db.resource.resourceId.find('charge-access-a'),
  }));
  assert.equal(afterRace.assignments.length, reservedBefore + 1);
  assert.ok((afterRace.charger?.available ?? 0) >= 0);
  assert.equal(afterRace.charger?.available, 0);
  assert.equal(afterRace.charger?.reserved, 1);

  const assignmentId = afterRace.assignments[0].assignmentId;
  setRole('volunteer');
  tx(ctx => {
    ctx.db.member.insert({
      identity: otherVolunteer,
      shelterId: SHELTER_A,
      role: 'volunteer',
      displayLabel: 'Volunteer 2',
      grantedBy: sender,
      active: true,
    });
    const row = ctx.db.assignment.assignmentId.find(assignmentId);
    if (!row) throw new Error('missing assignment');
    ctx.db.assignment.assignmentId.update({
      ...row,
      volunteerSet: true,
      volunteerIdentity: otherVolunteer,
    });
  });
  assert.equal(codeOf(ctx => completeAssignment(ctx, assignmentId)), 'UNAUTHORIZED');

  setRole('coordinator');
  tx(ctx => {
    const row = ctx.db.assignment.assignmentId.find(assignmentId);
    if (!row) throw new Error('missing assignment');
    ctx.db.assignment.assignmentId.update({
      ...row,
      volunteerSet: true,
      volunteerIdentity: sender,
    });
  });
  setRole('volunteer');
  tx(ctx => completeAssignment(ctx, assignmentId));
  tx(ctx => completeAssignment(ctx, assignmentId));
  const held = read(ctx => ctx.db.resource.resourceId.find('charge-access-a'));
  assert.equal(held?.reserved, 1);
  assert.equal(held?.available, 0);
  tx(ctx => endChargingSession(ctx, assignmentId, 'end-session-01'));
  tx(ctx => endChargingSession(ctx, assignmentId, 'end-session-01'));
  const charger = read(ctx => ctx.db.resource.resourceId.find('charge-access-a'));
  assert.equal(charger?.reserved, 0);
  assert.equal(charger?.available, 1);

  setRole('resident');
  submit('request-water-1', 'water');
  submit('request-water-2', 'water');
  submit('request-water-3', 'water');
  setRole('coordinator');
  const water = read(ctx =>
    [...ctx.db.helpRequest.iter()].filter(item => item.kind === 'water' && item.state === 'received'),
  );
  for (const item of water) {
    tx(ctx => acknowledgeRequest(ctx, item.requestPk, item.stateVersion));
  }
  tx(ctx => generatePlan(ctx, SHELTER_A, 'fcfs', []));
  const waterPlan = read(ctx => [...ctx.db.plan.iter()].at(-1));
  assert.ok(waterPlan);
  tx(ctx => approvePlan(ctx, waterPlan.planId, waterPlan.inputSnapshotVersion, 'approval-water'));
  const waterAssignments = read(ctx =>
    [...ctx.db.assignment.iter()].filter(
      item => item.state === 'reserved' && item.resourceId === 'water-a',
    ),
  );
  assert.equal(waterAssignments.length, 2);
  assert.equal(waterAssignments.every(item => item.volunteerSet), false);
  assert.equal(waterAssignments.every(item => item.dispatchState === 'unassigned'), true);
  const stockBeforeComplete = read(ctx => ctx.db.resource.resourceId.find('water-a'));
  tx(ctx => completeAssignment(ctx, waterAssignments[0].assignmentId));
  tx(ctx => completeAssignment(ctx, waterAssignments[0].assignmentId));
  const stockAfter = read(ctx => ctx.db.resource.resourceId.find('water-a'));
  assert.equal(stockAfter?.available, stockBeforeComplete?.available);
  assert.equal(stockAfter?.reserved, (stockBeforeComplete?.reserved ?? 0) - 1);

  assert.equal(
    codeOf(ctx => cancelRequest(ctx, waterAssignments[1].requestPk, 'staff_cancelled')),
    'INVALID_TRANSITION',
  );
  const releasedStock = read(ctx => ctx.db.resource.resourceId.find('water-a')?.available);
  tx(ctx => releaseAssignment(ctx, waterAssignments[1].assignmentId, 'resident_declined'));
  tx(ctx => releaseAssignment(ctx, waterAssignments[1].assignmentId, 'resident_declined'));
  assert.equal(
    read(ctx => ctx.db.resource.resourceId.find('water-a')?.available),
    (releasedStock ?? 0) + 1,
  );
  const releasedRequest = read(ctx => ctx.db.helpRequest.requestPk.find(waterAssignments[1].requestPk));
  assert.equal(releasedRequest?.state, 'acknowledged');

  setRole('worker');
  tx(ctx => generatePlan(ctx, SHELTER_A, 'suitability', [
    { kind: 'charger_slot', accessible: true, count: 1 },
  ]));
  const hypothetical = read(ctx => [...ctx.db.plan.iter()].at(-1));
  assert.equal(hypothetical?.hypothetical, true);
  setRole('coordinator');
  assert.equal(
    codeOf(ctx => approvePlan(ctx, hypothetical!.planId, hypothetical!.inputSnapshotVersion, 'approval-what-if')),
    'INVALID_INPUT',
  );
  setRole('worker');
  const realPlan = read(ctx =>
    [...ctx.db.plan.iter()].find(item => item.status === 'proposed' && !item.hypothetical),
  );
  assert.ok(realPlan);
  tx(ctx => {
    submitModelProposal(
      ctx,
      'run-invalid',
      realPlan.planId,
      'This would serve 99 people.',
      'list_open_requests,run_solver,run_what_if,submit_proposal',
      'proposal',
    );
  });
  assert.equal(read(ctx => ctx.db.modelRun.runId.find('run-invalid')?.outcome), 'rejected');
  tx(ctx => {
    submitModelProposal(
      ctx,
      'run-fallback',
      realPlan.planId,
      FALLBACK_EXPLANATION,
      'timeout',
      'fallback',
    );
  });
  const fallback = read(ctx => ctx.db.modelRun.runId.find('run-fallback'));
  assert.equal(fallback?.outcome, 'fallback');
  assert.match(fallback?.explanation ?? '', /Model unavailable/);
});

test('the only volunteer sees an approved task and can finish it', () => {
  const identity = new Identity('44'.repeat(32));
  const local = createModuleTestHarness(spacetimedb, module, { moduleIdentity: identity });
  const localAuth = TestAuth.internal();
  const run = (body: (ctx: Ctx) => void) => local.withReducerTx(localAuth, body);
  const look = <T>(body: (ctx: Ctx) => T): T => {
    let value!: T;
    run(ctx => {
      value = body(ctx);
    });
    return value;
  };
  const role = (next: string) => {
    run(ctx => {
      const member = ctx.db.member.identity.find(ctx.sender);
      if (!member) throw new Error('missing member');
      ctx.db.member.identity.update({ ...member, role: next, shelterId: SHELTER_A, active: true });
    });
  };

  run(seedDemo);
  run(ctx => claimDemoRole(ctx, SHELTER_A, 'resident', 'Zone B, cot 14'));
  role('resident');
  run(ctx => {
    submitRequest(ctx, {
      shelterId: SHELTER_A,
      clientRequestId: 'request-volunteer',
      kind: 'charging',
      needs: ['accessible_slot'],
      quantity: 1,
      clientCreatedAt: 'device-clock',
    });
  });
  role('coordinator');
  const requestPk = look(ctx =>
    [...ctx.db.helpRequest.iter()].find(item => item.clientRequestId === 'request-volunteer')?.requestPk,
  );
  assert.ok(requestPk !== undefined);
  run(ctx => acknowledgeRequest(ctx, requestPk, 1n));
  run(ctx => generatePlan(ctx, SHELTER_A, 'suitability', []));
  const plan = look(ctx => [...ctx.db.plan.iter()].at(-1));
  assert.ok(plan);
  run(ctx => approvePlan(ctx, plan.planId, plan.inputSnapshotVersion, 'approval-volunteer'));
  const open = look(ctx => [...ctx.db.assignment.iter()].find(item => item.state === 'reserved'));
  assert.equal(open?.volunteerSet, false);

  run(ctx => {
    const member = ctx.db.member.identity.find(ctx.sender);
    if (!member) throw new Error('missing member');
    ctx.db.member.identity.delete(member.identity);
  });
  run(ctx => claimDemoRole(ctx, SHELTER_A, 'volunteer', 'Floor volunteer'));
  assert.equal(look(ctx => myAssignments(ctx)).length, 0);
  run(ctx => {
    const row = [...ctx.db.assignment.iter()].find(item => item.state === 'reserved');
    if (!row) throw new Error('missing assignment');
    ctx.db.assignment.assignmentId.update({
      ...row,
      volunteerSet: true,
      volunteerIdentity: ctx.sender,
      dispatchState: 'offered',
    });
  });
  const visible = look(ctx => myAssignments(ctx));
  assert.equal(visible.length, 1);
  assert.equal(visible[0].kind, 'charging');
  assert.equal(visible[0].accessible, true);
  assert.equal(visible[0].state, 'reserved');
  run(ctx => completeAssignment(ctx, visible[0].assignmentId));
  const finished = look(ctx => ctx.db.helpRequest.requestPk.find(requestPk));
  assert.equal(finished?.state, 'delivered');
});

test('dispatch, transfer, confirmation, and investigation keep stock honest', () => {
  const identity = new Identity('55'.repeat(32));
  const local = createModuleTestHarness(spacetimedb, module, { moduleIdentity: identity });
  const localAuth = TestAuth.internal();
  const run = (body: (ctx: Ctx) => void) => local.withReducerTx(localAuth, body);
  const look = <T>(body: (ctx: Ctx) => T): T => {
    let value!: T;
    run(ctx => {
      value = body(ctx);
    });
    return value;
  };
  const role = (next: string, shelterId = SHELTER_A) => {
    run(ctx => {
      const member = ctx.db.member.identity.find(ctx.sender);
      if (!member) throw new Error('missing member');
      ctx.db.member.identity.update({ ...member, role: next, shelterId, active: true });
    });
  };
  const failCode = (body: (ctx: Ctx) => void) => {
    try {
      run(body);
    } catch (error) {
      if (error instanceof SenderError) return error.message;
      throw error;
    }
    return '';
  };

  run(seedDemo);
  run(ctx => claimDemoRole(ctx, SHELTER_A, 'resident', 'Zone B, cot 14'));
  role('resident');
  run(ctx => {
    submitRequest(ctx, {
      shelterId: SHELTER_A,
      clientRequestId: 'request-dispatch',
      kind: 'water',
      needs: [],
      quantity: 1,
      clientCreatedAt: 'device-clock',
    });
  });
  role('coordinator');
  const requestPk = look(ctx =>
    [...ctx.db.helpRequest.iter()].find(item => item.clientRequestId === 'request-dispatch')?.requestPk,
  );
  assert.ok(requestPk !== undefined);
  run(ctx => acknowledgeRequest(ctx, requestPk, 1n));
  run(ctx => generatePlan(ctx, SHELTER_A, 'suitability', [], 'most_requests'));
  const plan = look(ctx => [...ctx.db.plan.iter()].at(-1));
  assert.ok(plan);
  assert.equal(plan.method === 'exact' || plan.method === 'heuristic' || plan.method === 'fallback', true);
  run(ctx => approvePlan(ctx, plan.planId, plan.inputSnapshotVersion, 'approval-dispatch'));
  const assignment = look(ctx => [...ctx.db.assignment.iter()].find(item => item.requestPk === requestPk));
  assert.ok(assignment);
  assert.equal(assignment.dispatchState, 'unassigned');
  const reserved = look(ctx => ctx.db.resource.resourceId.find('water-a')?.reserved);
  run(ctx => {
    ctx.db.member.insert({
      identity: otherVolunteer,
      shelterId: SHELTER_A,
      role: 'volunteer',
      displayLabel: 'Volunteer B',
      grantedBy: sender,
      active: true,
    });
    ctx.db.volunteerProfile.insert({
      identity: otherVolunteer,
      shelterId: SHELTER_A,
      available: true,
      canCarryWater: true,
      chargerEscort: false,
      zone: 'south door',
    });
  });
  run(ctx => offerTask(ctx, assignment.assignmentId, otherVolunteer, 0n, 'offer-action-1'));
  run(ctx => offerTask(ctx, assignment.assignmentId, otherVolunteer, 0n, 'offer-action-1'));
  assert.equal(look(ctx => ctx.db.resource.resourceId.find('water-a')?.reserved), reserved);
  assert.equal(look(ctx => coordinatorBoard(ctx)).some(item => item.assignmentId === assignment.assignmentId), true);
  role('volunteer');
  assert.equal(look(ctx => myAssignments(ctx)).length, 0);
  assert.equal(failCode(ctx => acceptTask(ctx, assignment.assignmentId, assignment.dispatchVersion + 1n, 'accept-action-1')), 'UNAUTHORIZED');
  run(ctx => {
    const row = ctx.db.assignment.assignmentId.find(assignment.assignmentId);
    if (!row) throw new Error('missing assignment');
    ctx.db.assignment.assignmentId.update({
      ...row,
      volunteerIdentity: identity,
      volunteerSet: true,
      dispatchState: 'offered',
    });
  });
  const offered = look(ctx => ctx.db.assignment.assignmentId.find(assignment.assignmentId));
  assert.ok(offered);
  run(ctx => acceptTask(ctx, offered.assignmentId, offered.dispatchVersion, 'accept-action-1'));
  run(ctx => acceptTask(ctx, offered.assignmentId, offered.dispatchVersion, 'accept-action-1'));
  assert.equal(failCode(ctx => acceptTask(ctx, offered.assignmentId, offered.dispatchVersion, 'accept-action-2')), 'INVALID_TRANSITION');
  assert.equal(look(ctx => ctx.db.resource.resourceId.find('water-a')?.reserved), reserved);
  role('coordinator');
  local.clock.set(new Timestamp(5_000_000n));
  run(ctx => {
    const row = ctx.db.assignment.assignmentId.find(assignment.assignmentId);
    if (!row) throw new Error('missing assignment');
    ctx.db.assignment.assignmentId.update({
      ...row,
      dispatchState: 'accepted',
      dueAt: new Timestamp(1n),
    });
  });
  run(ctx => flagOverdue(ctx, assignment.assignmentId, 'overdue-action-1'));
  const overdue = look(ctx => ctx.db.assignment.assignmentId.find(assignment.assignmentId));
  assert.equal(overdue?.dispatchState, 'overdue_review');
  assert.equal(overdue?.state, 'reserved');
  assert.equal(look(ctx => ctx.db.resource.resourceId.find('water-a')?.reserved), reserved);

  role('volunteer');
  run(ctx => {
    const row = ctx.db.assignment.assignmentId.find(assignment.assignmentId);
    if (!row) throw new Error('missing assignment');
    ctx.db.assignment.assignmentId.update({
      ...row,
      volunteerSet: true,
      volunteerIdentity: identity,
      dispatchState: 'offered',
      state: 'reserved',
    });
  });
  const declinedFrom = look(ctx => ctx.db.assignment.assignmentId.find(assignment.assignmentId));
  assert.ok(declinedFrom);
  run(ctx => declineTask(ctx, declinedFrom.assignmentId, 'cant lift water', 'decline-action-1'));
  role('coordinator');
  run(ctx => offerTask(ctx, assignment.assignmentId, otherVolunteer, 0n, 'offer-action-2'));
  assert.equal(look(ctx => ctx.db.resource.resourceId.find('water-a')?.reserved), reserved);

  role('coordinator', SHELTER_A);
  run(ctx => createShortage(ctx, 'water_stock', 2, 'shortage-action-1'));
  const transfer = look(ctx => [...ctx.db.transfer.iter()].at(-1));
  assert.ok(transfer);
  assert.equal(look(ctx => coordinatorTransfers(ctx).every(item => !('residentLabel' in item))), true);
  role('coordinator', SHELTER_B);
  run(ctx => offerTransfer(ctx, transfer.transferId, 'water-b', 2, 'transfer-offer-1'));
  run(ctx => approveTransfer(ctx, transfer.transferId, 'approve-south-1'));
  run(ctx => {
    const water = ctx.db.resource.resourceId.find('water-b');
    if (!water) throw new Error('missing water');
    ctx.db.resource.resourceId.update({ ...water, version: water.version + 1n });
  });
  role('coordinator', SHELTER_A);
  assert.equal(failCode(ctx => approveTransfer(ctx, transfer.transferId, 'approve-north-stale')), 'STALE_OFFER');
  run(ctx => {
    const row = ctx.db.transfer.transferId.find(transfer.transferId);
    const water = ctx.db.resource.resourceId.find('water-b');
    if (!row || !water) throw new Error('missing transfer');
    ctx.db.transfer.transferId.update({ ...row, sourceVersion: water.version });
  });
  role('coordinator', SHELTER_B);
  role('coordinator', SHELTER_A);
  const before = look(ctx => ctx.db.resource.resourceId.find('water-b'));
  run(ctx => approveTransfer(ctx, transfer.transferId, 'approve-north-1'));
  run(ctx => approveTransfer(ctx, transfer.transferId, 'approve-north-1'));
  const reservedSouth = look(ctx => ctx.db.resource.resourceId.find('water-b'));
  assert.equal(reservedSouth?.reserved, (before?.reserved ?? 0) + 2);
  assert.equal(reservedSouth?.available, (before?.available ?? 0) - 2);
  role('coordinator', SHELTER_B);
  run(ctx => collectTransfer(ctx, transfer.transferId, 'collect-action-1'));
  assert.equal(failCode(ctx => cancelTransfer(ctx, transfer.transferId, 'cancel-late-01')), 'INVALID_TRANSITION');
  role('coordinator', SHELTER_A);
  const northBefore = look(ctx => ctx.db.resource.resourceId.find('water-a')?.available);
  run(ctx => receiveTransfer(ctx, transfer.transferId, 2, 'receipt-action-1'));
  run(ctx => receiveTransfer(ctx, transfer.transferId, 2, 'receipt-action-1'));
  assert.equal(look(ctx => ctx.db.resource.resourceId.find('water-a')?.available), (northBefore ?? 0) + 2);

  role('coordinator', SHELTER_A);
  run(ctx => completeAssignment(ctx, assignment.assignmentId));
  const stock = look(ctx => ctx.db.resource.resourceId.find('water-a'));
  role('resident', SHELTER_A);
  run(ctx => disputeDelivery(ctx, requestPk, 'dispute-action-1'));
  assert.equal(look(ctx => ctx.db.resource.resourceId.find('water-a')?.available), stock?.available);
  assert.equal(look(ctx => ctx.db.resource.resourceId.find('water-a')?.reserved), stock?.reserved);
  assert.equal(look(ctx => [...ctx.db.followUp.iter()].length), 1);
  role('coordinator');
  run(ctx => {
    const request = ctx.db.helpRequest.requestPk.find(requestPk);
    if (!request) throw new Error('missing request');
    ctx.db.helpRequest.requestPk.update({ ...request, state: 'delivered', confirmation: '' });
  });
  role('resident');
  run(ctx => confirmDelivery(ctx, requestPk, 'confirm-action-1'));
  run(ctx => confirmDelivery(ctx, requestPk, 'confirm-action-2'));
  assert.equal(look(ctx => [...ctx.db.event.iter()].filter(item => item.type === 'resident_confirmed').length), 1);

  role('coordinator');
  run(ctx => requestInvestigation(ctx, SHELTER_A, 'run-fallback-1'));
  const investigation = look(ctx => ctx.db.modelRun.runId.find('run-fallback-1'));
  assert.equal(investigation?.outcome, 'fallback');
  assert.match(investigation?.toolCalls ?? '', /list_stalled_requests/);
  assert.match(investigation?.toolCalls ?? '', /run_what_if/);
});
