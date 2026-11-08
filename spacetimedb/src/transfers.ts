import { Identity } from 'spacetimedb';
import { clearSharedLocation, fail, logEvent, rememberAction, requireMember, type Ctx } from './logic';

const REASON = /^[A-Za-z0-9 ,.'-]{1,80}$/;

function conserved(offered: number, held: number, inTransit: number, received: number, lost: number) {
  if (held + inTransit + received + lost !== offered) fail('INVALID_TRANSITION');
}

function shelterName(ctx: { db: Ctx['db'] }, shelterId: string) {
  return ctx.db.shelter.shelterId.find(shelterId)?.name ?? shelterId;
}

function resourceOf(ctx: Ctx, shelterId: string, kind: string) {
  const row = [...ctx.db.resource.iter()].find(
    resource => resource.shelterId === shelterId && resource.kind === kind,
  );
  if (!row) fail('NOT_FOUND');
  return row;
}

export function createShortage(ctx: Ctx, kind: string, quantity: number, actionId: string) {
  const member = ctx.db.member.identity.find(ctx.sender);
  if (!member || member.role !== 'coordinator') fail('UNAUTHORIZED');
  if (rememberAction(ctx, actionId, member.shelterId, 'shortage')) return;
  if (kind !== 'water_stock' && kind !== 'charger_slot') fail('INVALID_INPUT');
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) fail('INVALID_INPUT');
  const other = member.shelterId === 'shelter-a' ? 'shelter-b' : member.shelterId === 'shelter-b' ? 'shelter-a' : '';
  if (!other) fail('INVALID_INPUT');
  ctx.db.transfer.insert({
    transferId: 0n,
    sourceShelterId: other,
    destShelterId: member.shelterId,
    kind,
    quantityRequested: quantity,
    quantityOffered: 0,
    quantityReceived: 0,
    quantityLost: 0,
    inTransit: 0,
    state: 'requested',
    sourceResourceId: '',
    destResourceId: '',
    sourceVersion: 0n,
    sourceApproved: false,
    destApproved: false,
    responsibleSet: false,
    responsibleVolunteer: Identity.zero(),
    volunteerState: 'unassigned',
    declineReason: '',
    assignmentId: 0n,
  });
  logEvent(ctx, member.shelterId, 'shortage_requested', other, actionId, `${kind}:${quantity}`);
}

export function offerTransfer(
  ctx: Ctx,
  transferId: bigint,
  resourceId: string,
  quantity: number,
  actionId: string,
) {
  const row = ctx.db.transfer.transferId.find(transferId);
  if (!row) fail('NOT_FOUND');
  requireMember(ctx, row.sourceShelterId, ['coordinator']);
  if (rememberAction(ctx, actionId, transferId.toString(), 'transfer_offer')) return;
  if (row.state !== 'requested' && row.state !== 'offered') fail('INVALID_TRANSITION');
  const resource = ctx.db.resource.resourceId.find(resourceId);
  if (!resource || resource.shelterId !== row.sourceShelterId || resource.kind !== row.kind) fail('INVALID_INPUT');
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > row.quantityRequested) fail('INVALID_INPUT');
  if (resource.available < quantity) fail('INSUFFICIENT_CAPACITY');
  ctx.db.transfer.transferId.update({
    ...row,
    quantityOffered: quantity,
    sourceResourceId: resourceId,
    sourceVersion: resource.version,
    state: 'offered',
    sourceApproved: false,
    destApproved: false,
  });
  logEvent(ctx, row.sourceShelterId, 'transfer_offered', transferId.toString(), actionId, String(quantity));
}

export function approveTransfer(ctx: Ctx, transferId: bigint, actionId: string) {
  const row = ctx.db.transfer.transferId.find(transferId);
  if (!row) fail('NOT_FOUND');
  const member = ctx.db.member.identity.find(ctx.sender);
  if (!member || member.role !== 'coordinator') fail('UNAUTHORIZED');
  const sourceSide = member.shelterId === row.sourceShelterId;
  const destSide = member.shelterId === row.destShelterId;
  if (!sourceSide && !destSide) fail('WRONG_SHELTER');
  if (rememberAction(ctx, actionId, transferId.toString(), `approve_${member.shelterId}`)) return;
  if (row.state !== 'offered' && row.state !== 'approved_reserved') fail('INVALID_TRANSITION');
  const sourceApproved = row.sourceApproved || sourceSide;
  const destApproved = row.destApproved || destSide;
  if (!sourceApproved || !destApproved) {
    ctx.db.transfer.transferId.update({ ...row, sourceApproved, destApproved });
    logEvent(ctx, member.shelterId, 'transfer_approved_side', transferId.toString(), actionId, member.shelterId);
    return;
  }
  const resource = ctx.db.resource.resourceId.find(row.sourceResourceId);
  if (!resource || resource.version !== row.sourceVersion) fail('STALE_OFFER');
  if (resource.available < row.quantityOffered) fail('INSUFFICIENT_CAPACITY');
  ctx.db.resource.resourceId.update({
    ...resource,
    available: resource.available - row.quantityOffered,
    reserved: resource.reserved + row.quantityOffered,
    version: resource.version + 1n,
  });
  ctx.db.transfer.transferId.update({
    ...row,
    sourceApproved: true,
    destApproved: true,
    state: 'approved_reserved',
    sourceVersion: resource.version + 1n,
  });
  conserved(row.quantityOffered, row.quantityOffered, 0, 0, 0);
  logEvent(ctx, member.shelterId, 'transfer_reserved', transferId.toString(), actionId, String(row.quantityOffered));
}

export function offerTransferTask(ctx: Ctx, transferId: bigint, volunteerIdentity: Identity, actionId: string) {
  const row = ctx.db.transfer.transferId.find(transferId);
  if (!row) fail('NOT_FOUND');
  requireMember(ctx, row.sourceShelterId, ['coordinator']);
  if (rememberAction(ctx, actionId, transferId.toString(), 'transfer_task_offer')) return;
  if (row.state !== 'approved_reserved') fail('INVALID_TRANSITION');
  const volunteer = ctx.db.member.identity.find(volunteerIdentity);
  const profile = ctx.db.volunteerProfile.identity.find(volunteerIdentity);
  if (!volunteer || volunteer.role !== 'volunteer' || volunteer.shelterId !== row.sourceShelterId) fail('INVALID_INPUT');
  if (!profile || !profile.available || (row.kind === 'water_stock' && !profile.canCarryWater)) fail('INVALID_INPUT');
  ctx.db.transfer.transferId.update({
    ...row,
    responsibleSet: true,
    responsibleVolunteer: volunteerIdentity,
    volunteerState: 'offered',
    declineReason: '',
  });
  logEvent(ctx, row.sourceShelterId, 'transfer_task_offered', transferId.toString(), actionId, '');
}

export function respondTransferTask(ctx: Ctx, transferId: bigint, accept: boolean, reason: string, actionId: string) {
  const row = ctx.db.transfer.transferId.find(transferId);
  if (!row) fail('NOT_FOUND');
  requireMember(ctx, row.sourceShelterId, ['volunteer']);
  if (rememberAction(ctx, actionId, transferId.toString(), accept ? 'transfer_accept' : 'transfer_decline')) return;
  if (!row.responsibleSet || !row.responsibleVolunteer.equals(ctx.sender) || row.volunteerState !== 'offered') {
    fail('UNAUTHORIZED');
  }
  if (!accept && !REASON.test(reason)) fail('INVALID_INPUT');
  ctx.db.transfer.transferId.update({
    ...row,
    responsibleSet: accept,
    responsibleVolunteer: accept ? row.responsibleVolunteer : Identity.zero(),
    volunteerState: accept ? 'accepted' : 'declined',
    declineReason: accept ? '' : reason,
  });
  logEvent(ctx, row.sourceShelterId, accept ? 'transfer_accepted' : 'transfer_declined', transferId.toString(), actionId, reason);
}

export function collectTransfer(ctx: Ctx, transferId: bigint, actionId: string) {
  const row = ctx.db.transfer.transferId.find(transferId);
  if (!row) fail('NOT_FOUND');
  const member = ctx.db.member.identity.find(ctx.sender);
  if (!member || member.shelterId !== row.sourceShelterId) fail('WRONG_SHELTER');
  const allowed =
    member.role === 'coordinator' ||
    (member.role === 'volunteer' && row.volunteerState === 'accepted' && row.responsibleVolunteer.equals(ctx.sender));
  if (!allowed) fail('UNAUTHORIZED');
  if (rememberAction(ctx, actionId, transferId.toString(), 'collect')) return;
  if (row.state !== 'approved_reserved') fail('INVALID_TRANSITION');
  const resource = ctx.db.resource.resourceId.find(row.sourceResourceId);
  if (!resource || resource.reserved < row.quantityOffered) fail('INVALID_TRANSITION');
  ctx.db.resource.resourceId.update({
    ...resource,
    reserved: resource.reserved - row.quantityOffered,
    version: resource.version + 1n,
  });
  ctx.db.transfer.transferId.update({
    ...row,
    state: 'in_transit',
    inTransit: row.quantityOffered,
  });
  conserved(row.quantityOffered, 0, row.quantityOffered, 0, 0);
  logEvent(ctx, row.sourceShelterId, 'transfer_collected', transferId.toString(), actionId, '');
}

export function cancelTransfer(ctx: Ctx, transferId: bigint, actionId: string) {
  const row = ctx.db.transfer.transferId.find(transferId);
  if (!row) fail('NOT_FOUND');
  const member = ctx.db.member.identity.find(ctx.sender);
  if (!member || member.role !== 'coordinator') fail('UNAUTHORIZED');
  if (member.shelterId !== row.sourceShelterId && member.shelterId !== row.destShelterId) fail('WRONG_SHELTER');
  if (rememberAction(ctx, actionId, transferId.toString(), 'cancel_transfer')) return;
  if (row.state === 'cancelled') return;
  if (row.state === 'in_transit' || row.state === 'received' || row.state === 'lost_adjusted') fail('INVALID_TRANSITION');
  if (row.state === 'approved_reserved') {
    const resource = ctx.db.resource.resourceId.find(row.sourceResourceId);
    if (!resource || resource.reserved < row.quantityOffered) fail('INVALID_TRANSITION');
    ctx.db.resource.resourceId.update({
      ...resource,
      reserved: resource.reserved - row.quantityOffered,
      available: resource.available + row.quantityOffered,
      version: resource.version + 1n,
    });
  }
  ctx.db.transfer.transferId.update({ ...row, state: 'cancelled', inTransit: 0 });
  logEvent(ctx, member.shelterId, 'transfer_cancelled', transferId.toString(), actionId, '');
}

export function receiveTransfer(ctx: Ctx, transferId: bigint, count: number, receiptId: string) {
  const row = ctx.db.transfer.transferId.find(transferId);
  if (!row) fail('NOT_FOUND');
  requireMember(ctx, row.destShelterId, ['coordinator']);
  if (rememberAction(ctx, receiptId, transferId.toString(), 'receive')) return;
  if (row.state !== 'in_transit') fail('INVALID_TRANSITION');
  if (!Number.isInteger(count) || count < 0 || count > row.inTransit) fail('INVALID_INPUT');
  const dest = resourceOf(ctx, row.destShelterId, row.kind);
  const lost = row.inTransit - count;
  ctx.db.resource.resourceId.update({
    ...dest,
    available: dest.available + count,
    capacityTotal: dest.capacityTotal + count,
    version: dest.version + 1n,
  });
  ctx.db.transfer.transferId.update({
    ...row,
    state: lost > 0 && count === 0 ? 'lost_adjusted' : 'received',
    inTransit: 0,
    quantityReceived: count,
    quantityLost: lost,
    destResourceId: dest.resourceId,
  });
  conserved(row.quantityOffered, 0, 0, count, lost);
  clearSharedLocation(ctx, `t:${transferId}`, row.destShelterId);
  logEvent(ctx, row.destShelterId, 'transfer_received', transferId.toString(), receiptId, String(count));
}

export function coordinatorTransfers(ctx: { db: Ctx['db']; sender: Identity }) {
  const member = ctx.db.member.identity.find(ctx.sender);
  if (!member || member.role !== 'coordinator') return [];
  return [...ctx.db.transfer.iter()]
    .filter(row => row.sourceShelterId === member.shelterId || row.destShelterId === member.shelterId)
    .map(row => {
      const source = ctx.db.resource.resourceId.find(row.sourceResourceId);
      return {
        transferId: row.transferId,
        sourceShelterId: row.sourceShelterId,
        destShelterId: row.destShelterId,
        sourceName: shelterName(ctx, row.sourceShelterId),
        destName: shelterName(ctx, row.destShelterId),
        kind: row.kind,
        quantityRequested: row.quantityRequested,
        quantityOffered: row.quantityOffered,
        quantityReceived: row.quantityReceived,
        quantityLost: row.quantityLost,
        inTransit: row.inTransit,
        state: row.state,
        stale: row.state === 'offered' && !!source && source.version !== row.sourceVersion,
        sourceVersion: row.sourceVersion,
        liveSourceVersion: source?.version ?? 0n,
        volunteerState: row.volunteerState,
        declineReason: row.declineReason,
      };
    });
}

export function myTransfers(ctx: { db: Ctx['db']; sender: Identity }) {
  const member = ctx.db.member.identity.find(ctx.sender);
  if (!member || member.role !== 'volunteer') return [];
  return [...ctx.db.transfer.iter()]
    .filter(row => row.responsibleSet && row.responsibleVolunteer.equals(ctx.sender))
    .map(row => ({
      transferId: row.transferId,
      sourceShelterId: row.sourceShelterId,
      destShelterId: row.destShelterId,
      sourceName: shelterName(ctx, row.sourceShelterId),
      destName: shelterName(ctx, row.destShelterId),
      kind: row.kind,
      quantityRequested: row.quantityRequested,
      quantityOffered: row.quantityOffered,
      quantityReceived: row.quantityReceived,
      quantityLost: row.quantityLost,
      inTransit: row.inTransit,
      state: row.state,
      stale: false,
      sourceVersion: row.sourceVersion,
      liveSourceVersion: row.sourceVersion,
      volunteerState: row.volunteerState,
      declineReason: row.declineReason,
    }));
}
