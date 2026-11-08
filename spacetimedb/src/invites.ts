import { Timestamp } from 'spacetimedb';
import { fail, logEvent, requireMember, type Ctx } from './logic';

const INVITE_ID = /^[A-Za-z0-9._:-]{8,80}$/;
const JOIN_ROLES = new Set(['resident', 'volunteer']);

export function createInvite(
  ctx: Ctx,
  inviteId: string,
  shelterId: string,
  role: string,
  taskId: string,
  expiresAtMicros: bigint,
  maxUses: number,
) {
  const creator = requireMember(ctx, shelterId, ['coordinator']);
  if (!INVITE_ID.test(inviteId) || taskId.length > 80) fail('INVALID_INPUT');
  if (!JOIN_ROLES.has(role)) fail('INVALID_INPUT');
  if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 20) fail('INVALID_INPUT');
  if (expiresAtMicros <= ctx.timestamp.microsSinceUnixEpoch) fail('INVALID_INPUT');
  if (ctx.db.invite.inviteId.find(inviteId)) fail('INVALID_INPUT');
  ctx.db.invite.insert({
    inviteId,
    shelterId,
    role,
    taskId,
    expiresAt: new Timestamp(expiresAtMicros),
    maxUses,
    useCount: 0,
    createdBy: creator.identity,
    active: true,
  });
  logEvent(ctx, shelterId, 'invite_created', inviteId, role, '');
}

export function acceptInvite(ctx: Ctx, inviteId: string) {
  const invite = ctx.db.invite.inviteId.find(inviteId);
  if (!invite || !invite.active) fail('NOT_FOUND');
  if (!JOIN_ROLES.has(invite.role)) fail('UNAUTHORIZED');
  if (invite.useCount >= invite.maxUses || ctx.timestamp.microsSinceUnixEpoch > invite.expiresAt.microsSinceUnixEpoch) {
    fail('INVALID_INPUT');
  }
  const existing = ctx.db.member.identity.find(ctx.sender);
  if (existing) {
    if (existing.shelterId === invite.shelterId && existing.role === invite.role && existing.active) return;
    fail('UNAUTHORIZED');
  }
  ctx.db.member.insert({
    identity: ctx.sender,
    shelterId: invite.shelterId,
    role: invite.role,
    displayLabel: invite.role === 'volunteer' ? 'Floor volunteer' : 'Resident',
    grantedBy: invite.createdBy,
    active: true,
  });
  if (invite.role === 'volunteer' && !ctx.db.volunteerProfile.identity.find(ctx.sender)) {
    ctx.db.volunteerProfile.insert({
      identity: ctx.sender,
      shelterId: invite.shelterId,
      available: true,
      canCarryWater: true,
      chargerEscort: true,
      zone: '',
    });
  }
  ctx.db.invite.inviteId.update({
    ...invite,
    useCount: invite.useCount + 1,
    active: invite.useCount + 1 < invite.maxUses,
  });
  logEvent(ctx, invite.shelterId, 'invite_accepted', inviteId, invite.role, '');
}

export function coordinatorInvites(ctx: { db: Ctx['db']; sender: Ctx['sender'] }) {
  const member = ctx.db.member.identity.find(ctx.sender);
  if (!member || member.role !== 'coordinator' || !member.active) return [];
  return [...ctx.db.invite.iter()].filter(row => row.shelterId === member.shelterId);
}
