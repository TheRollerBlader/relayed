import { Identity, Timestamp } from 'spacetimedb';
import { bump, fail, logEvent, rememberAction, requireMember, UNSET_TIME, type Ctx } from './logic';

const OFFERABLE = new Set(['unassigned', 'declined', 'cant_do', 'overdue_review']);
const REASON = /^[A-Za-z0-9 ,.'-]{1,80}$/;

function load(ctx: Ctx, assignmentId: bigint) {
  const row = ctx.db.assignment.assignmentId.find(assignmentId);
  if (!row) fail('NOT_FOUND');
  return row;
}

function profileFor(ctx: Ctx, identity: Identity, shelterId: string) {
  const member = ctx.db.member.identity.find(identity);
  const profile = ctx.db.volunteerProfile.identity.find(identity);
  if (
    !member ||
    !member.active ||
    member.role !== 'volunteer' ||
    member.shelterId !== shelterId ||
    !profile ||
    profile.shelterId !== shelterId ||
    !profile.available
  ) {
    fail('INVALID_INPUT');
  }
  return { member, profile };
}

function capabilityMatches(kind: string, profile: { canCarryWater: boolean; chargerEscort: boolean }) {
  if (kind === 'water_stock' || kind === 'water') return profile.canCarryWater;
  return profile.chargerEscort;
}

export function setVolunteerProfile(
  ctx: Ctx,
  identity: Identity,
  available: boolean,
  canCarryWater: boolean,
  chargerEscort: boolean,
  zone: string,
) {
  if (zone.length > 40) fail('INVALID_INPUT');
  const target = ctx.db.member.identity.find(identity);
  if (!target || target.role !== 'volunteer') fail('INVALID_INPUT');
  const actor = requireMember(ctx, target.shelterId, ['coordinator', 'volunteer']);
  if (actor.role === 'volunteer' && !actor.identity.equals(identity)) fail('UNAUTHORIZED');
  const existing = ctx.db.volunteerProfile.identity.find(identity);
  const next = {
    identity,
    shelterId: target.shelterId,
    available,
    canCarryWater,
    chargerEscort,
    zone,
  };
  if (existing) ctx.db.volunteerProfile.identity.update(next);
  else ctx.db.volunteerProfile.insert(next);
  logEvent(ctx, target.shelterId, 'volunteer_profile', identity.toHexString(), '', zone);
}

export function offerTask(
  ctx: Ctx,
  assignmentId: bigint,
  volunteerIdentity: Identity,
  dueAtMicros: bigint,
  actionId: string,
) {
  const row = load(ctx, assignmentId);
  requireMember(ctx, row.shelterId, ['coordinator']);
  if (rememberAction(ctx, actionId, assignmentId.toString(), 'offer')) return;
  if (row.state !== 'reserved' || !OFFERABLE.has(row.dispatchState)) fail('INVALID_TRANSITION');
  const request = ctx.db.helpRequest.requestPk.find(row.requestPk);
  const resource = ctx.db.resource.resourceId.find(row.resourceId);
  if (!request || !resource) fail('NOT_FOUND');
  const { profile } = profileFor(ctx, volunteerIdentity, row.shelterId);
  const kind = request.kind === 'water' ? 'water' : 'charging';
  if (!capabilityMatches(kind, profile)) fail('INVALID_INPUT');
  const reservedBefore = resource.reserved;
  ctx.db.assignment.assignmentId.update({
    ...row,
    volunteerSet: true,
    volunteerIdentity,
    dispatchState: 'offered',
    dispatchVersion: row.dispatchVersion + 1n,
    dueAt: dueAtMicros > 0n ? new Timestamp(dueAtMicros) : UNSET_TIME,
    declineReason: '',
  });
  const after = ctx.db.resource.resourceId.find(row.resourceId);
  if (!after || after.reserved !== reservedBefore) fail('INVALID_TRANSITION');
  logEvent(ctx, row.shelterId, 'task_offered', assignmentId.toString(), actionId, volunteerIdentity.toHexString());
}

export function acceptTask(ctx: Ctx, assignmentId: bigint, expectedVersion: bigint, actionId: string) {
  const row = load(ctx, assignmentId);
  requireMember(ctx, row.shelterId, ['volunteer']);
  if (rememberAction(ctx, actionId, assignmentId.toString(), 'accept')) return;
  if (!row.volunteerSet || !row.volunteerIdentity.equals(ctx.sender)) fail('UNAUTHORIZED');
  if (row.dispatchState !== 'offered') fail('INVALID_TRANSITION');
  if (row.dispatchVersion !== expectedVersion) fail('INVALID_TRANSITION');
  ctx.db.assignment.assignmentId.update({
    ...row,
    dispatchState: 'accepted',
    dispatchVersion: row.dispatchVersion + 1n,
  });
  logEvent(ctx, row.shelterId, 'task_accepted', assignmentId.toString(), actionId, '');
}

export function declineTask(ctx: Ctx, assignmentId: bigint, reason: string, actionId: string) {
  const row = load(ctx, assignmentId);
  requireMember(ctx, row.shelterId, ['volunteer']);
  if (rememberAction(ctx, actionId, assignmentId.toString(), 'decline')) return;
  if (!REASON.test(reason)) fail('INVALID_INPUT');
  if (!row.volunteerSet || !row.volunteerIdentity.equals(ctx.sender)) fail('UNAUTHORIZED');
  if (row.dispatchState !== 'offered') fail('INVALID_TRANSITION');
  const resource = ctx.db.resource.resourceId.find(row.resourceId);
  const reservedBefore = resource?.reserved;
  ctx.db.assignment.assignmentId.update({
    ...row,
    volunteerSet: false,
    volunteerIdentity: Identity.zero(),
    dispatchState: 'declined',
    dispatchVersion: row.dispatchVersion + 1n,
    declineReason: reason,
  });
  const after = ctx.db.resource.resourceId.find(row.resourceId);
  if (!after || after.reserved !== reservedBefore) fail('INVALID_TRANSITION');
  logEvent(ctx, row.shelterId, 'task_declined', assignmentId.toString(), actionId, reason);
}

export function startTask(ctx: Ctx, assignmentId: bigint, actionId: string) {
  const row = load(ctx, assignmentId);
  requireMember(ctx, row.shelterId, ['volunteer']);
  if (rememberAction(ctx, actionId, assignmentId.toString(), 'start')) return;
  if (!row.volunteerIdentity.equals(ctx.sender) || row.dispatchState !== 'accepted') fail('INVALID_TRANSITION');
  ctx.db.assignment.assignmentId.update({
    ...row,
    dispatchState: 'in_progress',
    dispatchVersion: row.dispatchVersion + 1n,
  });
  logEvent(ctx, row.shelterId, 'task_started', assignmentId.toString(), actionId, '');
}

export function reportCantDo(ctx: Ctx, assignmentId: bigint, reason: string, actionId: string) {
  const row = load(ctx, assignmentId);
  requireMember(ctx, row.shelterId, ['volunteer']);
  if (rememberAction(ctx, actionId, assignmentId.toString(), 'cant_do')) return;
  if (!REASON.test(reason)) fail('INVALID_INPUT');
  if (!row.volunteerIdentity.equals(ctx.sender)) fail('UNAUTHORIZED');
  if (row.dispatchState !== 'accepted' && row.dispatchState !== 'in_progress') fail('INVALID_TRANSITION');
  const resource = ctx.db.resource.resourceId.find(row.resourceId);
  const reservedBefore = resource?.reserved;
  ctx.db.assignment.assignmentId.update({
    ...row,
    volunteerSet: false,
    volunteerIdentity: Identity.zero(),
    dispatchState: 'cant_do',
    dispatchVersion: row.dispatchVersion + 1n,
    declineReason: reason,
  });
  const after = ctx.db.resource.resourceId.find(row.resourceId);
  if (!after || after.reserved !== reservedBefore) fail('INVALID_TRANSITION');
  logEvent(ctx, row.shelterId, 'task_cant_do', assignmentId.toString(), actionId, reason);
}

export function flagOverdue(ctx: Ctx, assignmentId: bigint, actionId: string) {
  const row = load(ctx, assignmentId);
  requireMember(ctx, row.shelterId, ['coordinator']);
  if (rememberAction(ctx, actionId, assignmentId.toString(), 'flag_overdue')) return;
  if (row.dueAt.microsSinceUnixEpoch === 0n || ctx.timestamp.microsSinceUnixEpoch <= row.dueAt.microsSinceUnixEpoch) {
    fail('INVALID_TRANSITION');
  }
  if (row.dispatchState !== 'accepted' && row.dispatchState !== 'in_progress' && row.dispatchState !== 'offered') {
    fail('INVALID_TRANSITION');
  }
  const resource = ctx.db.resource.resourceId.find(row.resourceId);
  const reservedBefore = resource?.reserved;
  ctx.db.assignment.assignmentId.update({
    ...row,
    dispatchState: 'overdue_review',
    dispatchVersion: row.dispatchVersion + 1n,
  });
  const after = ctx.db.resource.resourceId.find(row.resourceId);
  if (!after || after.reserved !== reservedBefore || after.available !== resource?.available) fail('INVALID_TRANSITION');
  logEvent(ctx, row.shelterId, 'task_overdue', assignmentId.toString(), actionId, '');
}

export function reassignTask(
  ctx: Ctx,
  assignmentId: bigint,
  volunteerIdentity: Identity,
  expectedVersion: bigint,
  reason: string,
  actionId: string,
) {
  const row = load(ctx, assignmentId);
  requireMember(ctx, row.shelterId, ['coordinator']);
  if (rememberAction(ctx, actionId, assignmentId.toString(), 'reassign')) return;
  if (!REASON.test(reason)) fail('INVALID_INPUT');
  if (row.dispatchVersion !== expectedVersion) fail('INVALID_TRANSITION');
  if (row.state !== 'reserved') fail('INVALID_TRANSITION');
  if (!OFFERABLE.has(row.dispatchState) && row.dispatchState !== 'offered') fail('INVALID_TRANSITION');
  const request = ctx.db.helpRequest.requestPk.find(row.requestPk);
  if (!request) fail('NOT_FOUND');
  const { profile } = profileFor(ctx, volunteerIdentity, row.shelterId);
  if (!capabilityMatches(request.kind, profile)) fail('INVALID_INPUT');
  const resource = ctx.db.resource.resourceId.find(row.resourceId);
  const reservedBefore = resource?.reserved;
  ctx.db.assignment.assignmentId.update({
    ...row,
    volunteerSet: true,
    volunteerIdentity,
    dispatchState: 'offered',
    dispatchVersion: row.dispatchVersion + 1n,
    declineReason: '',
  });
  const after = ctx.db.resource.resourceId.find(row.resourceId);
  if (!after || after.reserved !== reservedBefore) fail('INVALID_TRANSITION');
  bump(ctx, row.shelterId);
  logEvent(ctx, row.shelterId, 'task_reassigned', assignmentId.toString(), actionId, reason);
}
