import { Identity, Timestamp } from 'spacetimedb';
import { bump, fail, logEvent, rememberAction, requireMember, UNSET_TIME, type Ctx } from './logic';

const REASON = /^[A-Za-z0-9 ,.'-]{1,80}$/;

function openFollowUp(ctx: Ctx, request: { requestPk: bigint; shelterId: string }, reason: string) {
  ctx.db.followUp.insert({
    followUpId: 0n,
    shelterId: request.shelterId,
    requestPk: request.requestPk,
    reason,
    ownerSet: false,
    ownerIdentity: Identity.zero(),
    deadline: UNSET_TIME,
    state: 'open',
  });
}

export function confirmDelivery(ctx: Ctx, requestPk: bigint, actionId: string) {
  const request = ctx.db.helpRequest.requestPk.find(requestPk);
  if (!request) fail('NOT_FOUND');
  const member = requireMember(ctx, request.shelterId, ['resident', 'coordinator']);
  if (member.role === 'resident' && !request.residentIdentity.equals(ctx.sender)) fail('UNAUTHORIZED');
  if (rememberAction(ctx, actionId, requestPk.toString(), 'confirm')) return;
  if (request.confirmation === 'confirmed' || request.confirmation === 'staff_verified') return;
  if (request.state !== 'delivered') fail('INVALID_TRANSITION');
  ctx.db.helpRequest.requestPk.update({
    ...request,
    confirmation: member.role === 'coordinator' ? 'staff_verified' : 'confirmed',
    state: 'completed',
    stateVersion: request.stateVersion + 1n,
    updatedAt: ctx.timestamp,
  });
  bump(ctx, request.shelterId);
  logEvent(
    ctx,
    request.shelterId,
    member.role === 'coordinator' ? 'staff_verified' : 'resident_confirmed',
    requestPk.toString(),
    actionId,
    ctx.sender.toHexString(),
  );
}

export function disputeDelivery(ctx: Ctx, requestPk: bigint, actionId: string) {
  const request = ctx.db.helpRequest.requestPk.find(requestPk);
  if (!request) fail('NOT_FOUND');
  const member = requireMember(ctx, request.shelterId, ['resident']);
  if (!request.residentIdentity.equals(member.identity)) fail('UNAUTHORIZED');
  if (rememberAction(ctx, actionId, requestPk.toString(), 'dispute')) return;
  if (request.state !== 'delivered' && request.state !== 'completed') fail('INVALID_TRANSITION');
  const stockBefore = [...ctx.db.resource.iter()].map(resource => `${resource.resourceId}:${resource.available}:${resource.reserved}`);
  ctx.db.helpRequest.requestPk.update({
    ...request,
    confirmation: 'disputed',
    stateVersion: request.stateVersion + 1n,
    updatedAt: ctx.timestamp,
  });
  openFollowUp(ctx, request, 'did_not_receive');
  const stockAfter = [...ctx.db.resource.iter()].map(resource => `${resource.resourceId}:${resource.available}:${resource.reserved}`);
  if (stockBefore.join() !== stockAfter.join()) fail('INVALID_TRANSITION');
  bump(ctx, request.shelterId);
  logEvent(ctx, request.shelterId, 'resident_disputed', requestPk.toString(), actionId, '');
}

export function cantReceive(ctx: Ctx, requestPk: bigint, actionId: string) {
  const request = ctx.db.helpRequest.requestPk.find(requestPk);
  if (!request) fail('NOT_FOUND');
  const member = requireMember(ctx, request.shelterId, ['resident']);
  if (!request.residentIdentity.equals(member.identity)) fail('UNAUTHORIZED');
  if (rememberAction(ctx, actionId, requestPk.toString(), 'cant_receive')) return;
  if (request.state !== 'delivered' && request.state !== 'assigned') fail('INVALID_TRANSITION');
  ctx.db.helpRequest.requestPk.update({
    ...request,
    confirmation: 'cant_receive',
    stateVersion: request.stateVersion + 1n,
    updatedAt: ctx.timestamp,
  });
  openFollowUp(ctx, request, 'cant_receive');
  bump(ctx, request.shelterId);
  logEvent(ctx, request.shelterId, 'resident_unavailable', requestPk.toString(), actionId, '');
}

export function endChargingSession(ctx: Ctx, assignmentId: bigint, actionId: string) {
  const row = ctx.db.assignment.assignmentId.find(assignmentId);
  if (!row) fail('NOT_FOUND');
  const member = requireMember(ctx, row.shelterId, ['coordinator', 'volunteer']);
  const owns = member.role === 'volunteer' && row.volunteerSet && row.volunteerIdentity.equals(ctx.sender);
  if (member.role !== 'coordinator' && !owns) fail('UNAUTHORIZED');
  if (rememberAction(ctx, actionId, assignmentId.toString(), 'end_session')) return;
  if (row.state !== 'delivered') fail('INVALID_TRANSITION');
  const resource = ctx.db.resource.resourceId.find(row.resourceId);
  if (!resource || resource.kind !== 'charger_slot' || resource.reserved < row.units) fail('INVALID_TRANSITION');
  ctx.db.resource.resourceId.update({
    ...resource,
    reserved: resource.reserved - row.units,
    available: resource.available + row.units,
    version: resource.version + 1n,
  });
  ctx.db.assignment.assignmentId.update({ ...row, state: 'completed', dispatchState: 'delivered' });
  logEvent(ctx, row.shelterId, 'session_ended', assignmentId.toString(), actionId, '');
}

export function assignFollowUp(ctx: Ctx, followUpId: bigint, deadlineMicros: bigint, actionId: string) {
  const row = ctx.db.followUp.followUpId.find(followUpId);
  if (!row) fail('NOT_FOUND');
  requireMember(ctx, row.shelterId, ['coordinator']);
  if (rememberAction(ctx, actionId, followUpId.toString(), 'assign_follow_up')) return;
  if (deadlineMicros <= 0n) fail('INVALID_INPUT');
  ctx.db.followUp.followUpId.update({
    ...row,
    ownerSet: true,
    ownerIdentity: ctx.sender,
    deadline: new Timestamp(deadlineMicros),
    state: 'open',
  });
  logEvent(ctx, row.shelterId, 'follow_up_assigned', followUpId.toString(), actionId, ctx.sender.toHexString());
}

export function flagFollowUp(ctx: Ctx, followUpId: bigint, actionId: string) {
  const row = ctx.db.followUp.followUpId.find(followUpId);
  if (!row) fail('NOT_FOUND');
  requireMember(ctx, row.shelterId, ['coordinator']);
  if (rememberAction(ctx, actionId, followUpId.toString(), 'flag_follow_up')) return;
  if (!row.ownerSet || row.deadline.microsSinceUnixEpoch === 0n) fail('INVALID_TRANSITION');
  if (ctx.timestamp.microsSinceUnixEpoch <= row.deadline.microsSinceUnixEpoch) fail('INVALID_TRANSITION');
  if (row.state === 'overdue_review') return;
  ctx.db.followUp.followUpId.update({ ...row, state: 'overdue_review' });
  logEvent(ctx, row.shelterId, 'follow_up_overdue', followUpId.toString(), actionId, '');
}

export function setServeBy(ctx: Ctx, requestPk: bigint, deadlineMicros: bigint) {
  const request = ctx.db.helpRequest.requestPk.find(requestPk);
  if (!request) fail('NOT_FOUND');
  requireMember(ctx, request.shelterId, ['coordinator']);
  if (request.state !== 'received' && request.state !== 'acknowledged') fail('INVALID_TRANSITION');
  ctx.db.helpRequest.requestPk.update({
    ...request,
    serveBy: deadlineMicros > 0n ? new Timestamp(deadlineMicros) : UNSET_TIME,
    updatedAt: ctx.timestamp,
    stateVersion: request.stateVersion + 1n,
  });
  bump(ctx, request.shelterId);
  logEvent(ctx, request.shelterId, 'serve_by_set', requestPk.toString(), '', deadlineMicros.toString());
}

export function splitFulfillment(ctx: Ctx, requestPk: bigint, units: number, actionId: string) {
  const request = ctx.db.helpRequest.requestPk.find(requestPk);
  if (!request) fail('NOT_FOUND');
  requireMember(ctx, request.shelterId, ['coordinator']);
  if (rememberAction(ctx, actionId, requestPk.toString(), 'split')) return;
  if (request.kind !== 'water' || request.state !== 'assigned') fail('INVALID_TRANSITION');
  if (!Number.isInteger(units) || units < 1 || units >= request.quantity) fail('INVALID_INPUT');
  const assignment = [...ctx.db.assignment.iter()].find(
    item => item.requestPk === requestPk && item.state === 'reserved',
  );
  const resource = assignment ? ctx.db.resource.resourceId.find(assignment.resourceId) : undefined;
  if (!assignment || !resource || resource.reserved < assignment.units) fail('INVALID_TRANSITION');
  const remainder = request.quantity - units;
  ctx.db.resource.resourceId.update({
    ...resource,
    reserved: resource.reserved - assignment.units,
    available: resource.available + remainder,
    version: resource.version + 1n,
  });
  ctx.db.assignment.assignmentId.update({
    ...assignment,
    units,
    state: 'delivered',
    dispatchState: 'delivered',
    deliveredAt: ctx.timestamp,
  });
  ctx.db.helpRequest.requestPk.update({
    ...request,
    quantity: units,
    fulfilledUnits: units,
    state: 'delivered',
    updatedAt: ctx.timestamp,
    stateVersion: request.stateVersion + 1n,
  });
  ctx.db.helpRequest.insert({
    ...request,
    requestPk: 0n,
    clientRequestId: `backorder-${actionId}`.slice(0, 80),
    idempotencyKey: `${request.shelterId}\u001fbackorder-${actionId}`,
    quantity: remainder,
    payloadHash: `water|${request.needs}|${remainder}`,
    receivedAt: request.receivedAt,
    updatedAt: ctx.timestamp,
    state: 'acknowledged',
    stateVersion: 1n,
    fulfilledUnits: 0,
    confirmation: '',
    backorderOf: request.requestPk,
    cancelReason: '',
  });
  ctx.db.observation.insert({
    observationId: 0n,
    shelterId: request.shelterId,
    kind: 'consumption',
    resourceKind: 'water_stock',
    units,
    at: ctx.timestamp,
    durationMicros: 0n,
  });
  bump(ctx, request.shelterId);
  logEvent(ctx, request.shelterId, 'request_split', requestPk.toString(), actionId, String(remainder));
}

export function coordinatorFollowUps(ctx: { db: Ctx['db']; sender: Identity }) {
  const member = ctx.db.member.identity.find(ctx.sender);
  if (!member || member.role !== 'coordinator') return [];
  return [...ctx.db.followUp.iter()]
    .filter(row => row.shelterId === member.shelterId)
    .map(row => ({
      followUpId: row.followUpId,
      requestPk: row.requestPk,
      reason: row.reason,
      state: row.state,
      deadline: row.deadline,
      ownerLabel: row.ownerSet ? 'Desk lead' : '',
    }));
}

export function sessionShelter(ctx: { db: Ctx['db']; sender: Identity }) {
  const member = ctx.db.member.identity.find(ctx.sender);
  if (!member) return [];
  const shelter = ctx.db.shelter.shelterId.find(member.shelterId);
  if (!shelter) return [];
  return [{
    shelterId: shelter.shelterId,
    name: shelter.name,
    confirmWater: shelter.confirmWater,
    confirmCharging: shelter.confirmCharging,
  }];
}

export function priorityReasonOk(reason: string) {
  return REASON.test(reason);
}
