import { Identity, Timestamp } from 'spacetimedb';
import { SenderError, type InferSchema, type ReducerCtx } from 'spacetimedb/server';
import spacetimedb from './schema';
import {
  AGING_RULE,
  applyWhatIf,
  solve,
  type Policy,
  type SolverRequest,
  type SolverResource,
  type WhatIfAdd,
} from './solver';

export type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;
type ReadCtx = { db: Ctx['db']; sender: Identity; timestamp: Timestamp };

export const SHELTER_A = 'shelter-a';
export const SHELTER_B = 'shelter-b';
export const FALLBACK_EXPLANATION = 'Model unavailable; deterministic plan only.';

const ROLES = new Set(['resident', 'coordinator', 'volunteer', 'worker']);
const LABEL = /^[A-Za-z0-9 ,.-]{1,40}$/;
const ID = /^[A-Za-z0-9._:-]{8,80}$/;
const RELEASE_REASONS = new Set(['slot_returned', 'resident_declined', 'plan_changed']);
const CANCEL_STAFF = new Set(['staff_cancelled', 'duplicate']);
const REJECT_REASONS = new Set(['out_of_scope', 'invalid_request']);
const MODEL_OUTCOMES = new Set(['proposal', 'rejected', 'timeout', 'fallback']);

const QUEUE_RANK: Record<string, number> = {
  received: 0,
  acknowledged: 1,
  assigned: 2,
  rejected: 3,
  cancelled: 4,
  completed: 5,
};

export function fail(code: string): never {
  throw new SenderError(code);
}

export const UNSET_TIME = Timestamp.UNIX_EPOCH;
const POLICIES = new Set(['most_requests', 'most_quantity', 'longest_wait', 'accessible_coverage']);
const REASON = /^[A-Za-z0-9 ,.'-]{1,80}$/;

export function hostConfig(ctx: { db: Ctx['db'] }) {
  const row = ctx.db.moduleConfig.configId.find('host');
  return {
    authMode: row?.authMode === 'real' ? 'real' : 'demo',
    aiMode: row?.aiMode === 'queue' ? 'queue' : 'inline',
    oidcIssuer: row?.oidcIssuer ?? '',
    oidcAudience: row?.oidcAudience ?? '',
    bootstrapAdminSub: row?.bootstrapAdminSub ?? '',
  };
}

export function applyPublishedEnv(ctx: Ctx) {
  const current = ctx.db.moduleConfig.configId.find('host');
  const authMode = ctx.env.get('AUTH_MODE');
  const aiMode = ctx.env.get('AI_MODE');
  const issuer = ctx.env.get('OIDC_ISSUER');
  const audience = ctx.env.get('OIDC_AUDIENCE');
  const admin = ctx.env.get('BOOTSTRAP_ADMIN_SUB');
  const next = {
    configId: 'host',
    authMode: authMode === 'real' ? 'real' : authMode === 'demo' ? 'demo' : (current?.authMode ?? 'demo'),
    aiMode: aiMode === 'queue' ? 'queue' : aiMode === 'inline' ? 'inline' : (current?.aiMode ?? 'inline'),
    oidcIssuer: issuer || current?.oidcIssuer || '',
    oidcAudience: audience || current?.oidcAudience || '',
    bootstrapAdminSub: admin || current?.bootstrapAdminSub || '',
  };
  if (current) ctx.db.moduleConfig.configId.update(next);
  else ctx.db.moduleConfig.insert(next);
}

export function assertSession(ctx: Ctx) {
  const host = hostConfig(ctx);
  if (host.authMode !== 'real') return;
  const auth = ctx.senderAuth;
  if (!auth.hasJWT || !auth.jwt) fail('UNAUTHORIZED');
  if (!host.oidcIssuer || auth.jwt.issuer !== host.oidcIssuer) fail('UNAUTHORIZED');
  if (!host.oidcAudience || !auth.jwt.audience.includes(host.oidcAudience)) fail('UNAUTHORIZED');
}

export function clearSharedLocation(ctx: Ctx, subjectKey: string, shelterId: string) {
  const row = ctx.db.taskLocationLatest.subjectKey.find(subjectKey);
  if (!row) return;
  ctx.db.taskLocationLatest.subjectKey.delete(subjectKey);
  logEvent(ctx, shelterId, 'location_sharing_stopped', subjectKey, '', '');
}

export function requireMember(ctx: Ctx, shelterId: string, roles: readonly string[]) {
  const member = ctx.db.member.identity.find(ctx.sender);
  if (!member || !member.active) fail('UNAUTHORIZED');
  if (member.shelterId !== shelterId) fail('WRONG_SHELTER');
  if (!roles.includes(member.role)) fail('UNAUTHORIZED');
  return member;
}

export function bump(ctx: Ctx, shelterId: string): bigint {
  const row = ctx.db.shelterVersion.shelterId.find(shelterId);
  if (!row) fail('NOT_FOUND');
  const snapshotVersion = row.snapshotVersion + 1n;
  ctx.db.shelterVersion.shelterId.update({ ...row, snapshotVersion });
  return snapshotVersion;
}

export function logEvent(
  ctx: Ctx,
  shelterId: string,
  type: string,
  subjectId: string,
  correlationId: string,
  details: string,
) {
  ctx.db.event.insert({
    eventId: 0n,
    shelterId,
    at: ctx.timestamp,
    actorIdentity: ctx.sender,
    type,
    subjectId,
    correlationId,
    details,
  });
}

function canonicalNeeds(needs: readonly string[]): string {
  const unique = [...new Set(needs)];
  if (unique.length > 1) fail('INVALID_INPUT');
  if (unique.length === 1 && unique[0] !== 'accessible_slot') fail('INVALID_INPUT');
  return unique[0] ?? '';
}

function payloadHash(kind: string, needs: string, quantity: number): string {
  return `${kind}|${needs}|${quantity}`;
}

function solverRequests(ctx: ReadCtx, shelterId: string): SolverRequest[] {
  return [...ctx.db.helpRequest.iter()]
    .filter(request => request.shelterId === shelterId)
    .map(request => ({
      requestPk: request.requestPk,
      kind: request.kind === 'charging' ? 'charging' : 'water',
      needsAccessible: request.needs === 'accessible_slot',
      quantity: request.quantity,
      receivedAtMicros: request.receivedAt.microsSinceUnixEpoch,
      humanPriority: request.humanPriority,
      state: request.state,
    }));
}

function solverResources(ctx: ReadCtx, shelterId: string): SolverResource[] {
  return [...ctx.db.resource.iter()]
    .filter(resource => resource.shelterId === shelterId)
    .map(resource => ({
      resourceId: resource.resourceId,
      kind: resource.kind === 'charger_slot' ? 'charger_slot' : 'water_stock',
      accessible: resource.accessible,
      available: resource.available,
    }));
}

function validateWhatIf(
  adds: readonly { kind: string; accessible: boolean; count: number }[],
): WhatIfAdd[] {
  if (adds.length > 3) fail('INVALID_INPUT');
  return adds.map(add => {
    if (add.kind !== 'water_stock' && add.kind !== 'charger_slot') fail('INVALID_INPUT');
    if (!Number.isInteger(add.count) || add.count < 1 || add.count > 3) fail('INVALID_INPUT');
    return {
      kind: add.kind,
      accessible: add.accessible,
      count: add.count,
    };
  });
}

export function seedDemo(ctx: Ctx) {
  if (ctx.db.shelter.shelterId.find(SHELTER_A)) return;
  ctx.db.shelter.insert({
    shelterId: SHELTER_A,
    name: 'North Hall',
    status: 'open',
    confirmWater: true,
    confirmCharging: true,
  });
  ctx.db.shelter.insert({
    shelterId: SHELTER_B,
    name: 'South Hall',
    status: 'open',
    confirmWater: true,
    confirmCharging: true,
  });
  ctx.db.shelterVersion.insert({ shelterId: SHELTER_A, snapshotVersion: 1n });
  ctx.db.shelterVersion.insert({ shelterId: SHELTER_B, snapshotVersion: 1n });
  if (!ctx.db.moduleConfig.configId.find('host')) {
    ctx.db.moduleConfig.insert({
      configId: 'host',
      authMode: 'demo',
      aiMode: 'inline',
      oidcIssuer: '',
      oidcAudience: '',
      bootstrapAdminSub: '',
    });
  }
  const resources = [
    ['water-a', SHELTER_A, 'water_stock', false, 2],
    ['charge-general-a', SHELTER_A, 'charger_slot', false, 1],
    ['charge-access-a', SHELTER_A, 'charger_slot', true, 1],
    ['water-b', SHELTER_B, 'water_stock', false, 6],
    ['charge-access-b', SHELTER_B, 'charger_slot', true, 1],
  ] as const;
  for (const [resourceId, shelterId, kind, accessible, capacity] of resources) {
    ctx.db.resource.insert({
      resourceId,
      shelterId,
      kind,
      accessible,
      capacityTotal: capacity,
      available: capacity,
      reserved: 0,
      version: 1n,
    });
  }
}

export function claimDemoRole(
  ctx: Ctx,
  shelterId: string,
  role: string,
  displayLabel: string,
) {
  if (hostConfig(ctx).authMode === 'real') fail('UNAUTHORIZED');
  if (!ctx.db.shelter.shelterId.find(shelterId)) fail('NOT_FOUND');
  if (!ROLES.has(role)) fail('INVALID_INPUT');
  if (!LABEL.test(displayLabel)) fail('INVALID_INPUT');
  const existing = ctx.db.member.identity.find(ctx.sender);
  if (existing) {
    if (existing.shelterId === shelterId && existing.role === role) return;
    fail('UNAUTHORIZED');
  }
  ctx.db.member.insert({
    identity: ctx.sender,
    shelterId,
    role,
    displayLabel,
    grantedBy: ctx.sender,
    active: true,
  });
  if (role === 'volunteer' && !ctx.db.volunteerProfile.identity.find(ctx.sender)) {
    ctx.db.volunteerProfile.insert({
      identity: ctx.sender,
      shelterId,
      available: true,
      canCarryWater: true,
      chargerEscort: true,
      zone: '',
    });
  }
}

const GRANTED_ROLES = new Set(['resident', 'coordinator', 'volunteer', 'worker']);

export function grantMembership(
  ctx: Ctx,
  identity: Identity,
  shelterId: string,
  role: string,
  displayLabel: string,
) {
  const host = hostConfig(ctx);
  if (host.authMode !== 'real') fail('UNAUTHORIZED');
  const subject = ctx.senderAuth.jwt?.subject ?? '';
  if (!host.bootstrapAdminSub || subject !== host.bootstrapAdminSub) fail('UNAUTHORIZED');
  if (!ctx.db.shelter.shelterId.find(shelterId)) fail('NOT_FOUND');
  if (!GRANTED_ROLES.has(role) || !LABEL.test(displayLabel)) fail('INVALID_INPUT');
  const existing = ctx.db.member.identity.find(identity);
  if (existing) {
    ctx.db.member.identity.update({
      ...existing,
      shelterId,
      role,
      displayLabel,
      grantedBy: ctx.sender,
      active: true,
    });
  } else {
    ctx.db.member.insert({
      identity,
      shelterId,
      role,
      displayLabel,
      grantedBy: ctx.sender,
      active: true,
    });
  }
  if (role === 'volunteer' && !ctx.db.volunteerProfile.identity.find(identity)) {
    ctx.db.volunteerProfile.insert({
      identity,
      shelterId,
      available: true,
      canCarryWater: true,
      chargerEscort: true,
      zone: '',
    });
  }
  logEvent(ctx, shelterId, 'membership_granted', identity.toHexString(), role, '');
}

export function myMembership(ctx: { db: Ctx['db']; sender: Identity }) {
  const member = ctx.db.member.identity.find(ctx.sender);
  if (!member || !member.active) return [];
  return [
    {
      identity: member.identity,
      shelterId: member.shelterId,
      role: member.role,
      displayLabel: member.displayLabel,
      active: member.active,
    },
  ];
}

export function endClientSession(ctx: Ctx) {
  for (const row of [...ctx.db.taskLocationLatest.iter()]) {
    if (row.volunteerIdentity.equals(ctx.sender)) clearSharedLocation(ctx, row.subjectKey, row.shelterId);
  }
}

export function submitRequest(
  ctx: Ctx,
  input: {
    shelterId: string;
    clientRequestId: string;
    kind: string;
    needs: readonly string[];
    quantity: number;
    clientCreatedAt: string;
  },
) {
  requireMember(ctx, input.shelterId, ['resident']);
  if (input.kind !== 'water' && input.kind !== 'charging') fail('INVALID_INPUT');
  if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 20) {
    fail('INVALID_INPUT');
  }
  if (input.kind === 'charging' && input.quantity !== 1) fail('INVALID_INPUT');
  if (!ID.test(input.clientRequestId)) fail('INVALID_INPUT');
  if (input.clientCreatedAt.length > 40) fail('INVALID_INPUT');
  const needs = canonicalNeeds(input.needs);
  const hash = payloadHash(input.kind, needs, input.quantity);
  const idempotencyKey = `${input.shelterId}\u001f${input.clientRequestId}`;
  const existing = ctx.db.helpRequest.idempotencyKey.find(idempotencyKey);
  if (existing) {
    if (existing.payloadHash !== hash) fail('IDEMPOTENCY_CONFLICT');
    return;
  }
  const row = ctx.db.helpRequest.insert({
    requestPk: 0n,
    shelterId: input.shelterId,
    clientRequestId: input.clientRequestId,
    idempotencyKey,
    residentIdentity: ctx.sender,
    kind: input.kind,
    needs,
    quantity: input.quantity,
    payloadHash: hash,
    clientCreatedAt: input.clientCreatedAt,
    receivedAt: ctx.timestamp,
    updatedAt: ctx.timestamp,
    serveBy: UNSET_TIME,
    state: 'received',
    stateVersion: 1n,
    humanPriority: 0,
    priorityReason: '',
    cancelReason: '',
    confirmation: '',
    fulfilledUnits: 0,
    backorderOf: 0n,
  });
  ctx.db.observation.insert({
    observationId: 0n,
    shelterId: input.shelterId,
    kind: 'arrival',
    resourceKind: input.kind === 'water' ? 'water_stock' : 'charger_slot',
    units: input.quantity,
    at: ctx.timestamp,
    durationMicros: 0n,
  });
  bump(ctx, input.shelterId);
  logEvent(
    ctx,
    input.shelterId,
    'request_received',
    row.requestPk.toString(),
    input.clientRequestId,
    input.kind,
  );
}

export function acknowledgeRequest(
  ctx: Ctx,
  requestPk: bigint,
  expectedStateVersion: bigint,
) {
  const request = ctx.db.helpRequest.requestPk.find(requestPk);
  if (!request) fail('NOT_FOUND');
  requireMember(ctx, request.shelterId, ['coordinator']);
  if (request.state === 'acknowledged') return;
  if (request.state !== 'received' || request.stateVersion !== expectedStateVersion) {
    fail('INVALID_TRANSITION');
  }
  ctx.db.helpRequest.requestPk.update({
    ...request,
    state: 'acknowledged',
    stateVersion: request.stateVersion + 1n,
    updatedAt: ctx.timestamp,
  });
  bump(ctx, request.shelterId);
  logEvent(
    ctx,
    request.shelterId,
    'request_acknowledged',
    requestPk.toString(),
    request.clientRequestId,
    '',
  );
}

export function setHumanPriority(
  ctx: Ctx,
  requestPk: bigint,
  level: number,
  reasonCode: string,
  reason: string,
) {
  const request = ctx.db.helpRequest.requestPk.find(requestPk);
  if (!request) fail('NOT_FOUND');
  requireMember(ctx, request.shelterId, ['coordinator']);
  if (![1, 2, 3].includes(level) || reasonCode !== 'staff_set' || !REASON.test(reason)) {
    fail('INVALID_INPUT');
  }
  if (request.state !== 'received' && request.state !== 'acknowledged') fail('INVALID_TRANSITION');
  ctx.db.helpRequest.requestPk.update({
    ...request,
    humanPriority: level,
    priorityReason: reason,
    stateVersion: request.stateVersion + 1n,
    updatedAt: ctx.timestamp,
  });
  bump(ctx, request.shelterId);
  logEvent(ctx, request.shelterId, 'priority_set', requestPk.toString(), reason, String(level));
}

/**
 * Resource invariant. Do not change these numbers without a new explicit rule.
 * capacityTotal is the installed or stocked amount. Handing out water does not reduce it.
 * available is unpromised units. reserved is promised and not yet finished.
 * Enforced rule: available >= 0, available is at least reserved, and
 * capacityTotal >= available + reserved.
 * Water completion consumes units: reserved drops, available stays, total stays.
 * Consumed water is capacityTotal - available - reserved.
 * Charger completion returns the slot immediately until session-end release replaces it.
 */
export function updateResource(
  ctx: Ctx,
  resourceId: string,
  expectedVersion: bigint,
  capacityTotal: number,
  available: number,
) {
  const resource = ctx.db.resource.resourceId.find(resourceId);
  if (!resource) fail('NOT_FOUND');
  requireMember(ctx, resource.shelterId, ['coordinator']);
  if (resource.version !== expectedVersion) fail('INVALID_INPUT');
  if (!Number.isInteger(capacityTotal) || !Number.isInteger(available)) fail('INVALID_INPUT');
  if (available < 0 || available < resource.reserved) fail('INVALID_INPUT');
  if (capacityTotal < available + resource.reserved) fail('INVALID_INPUT');
  ctx.db.resource.resourceId.update({
    ...resource,
    capacityTotal,
    available,
    version: resource.version + 1n,
  });
  bump(ctx, resource.shelterId);
  logEvent(
    ctx,
    resource.shelterId,
    'resource_updated',
    resourceId,
    '',
    `available=${available}`,
  );
}

export function generatePlan(
  ctx: Ctx,
  shelterId: string,
  strategy: string,
  whatIf: readonly { kind: string; accessible: boolean; count: number }[],
  policy = 'most_requests',
) {
  const member = requireMember(ctx, shelterId, ['coordinator', 'worker']);
  if (strategy !== 'fcfs' && strategy !== 'suitability') fail('INVALID_INPUT');
  if (!POLICIES.has(policy)) fail('INVALID_INPUT');
  const adds = validateWhatIf(whatIf);
  const snapshot = ctx.db.shelterVersion.shelterId.find(shelterId);
  if (!snapshot) fail('NOT_FOUND');
  const before = [...ctx.db.resource.iter()].map(resource => resource.available);
  const requests = solverRequests(ctx, shelterId);
  const base = solverResources(ctx, shelterId);
  const resources = adds.length > 0 ? applyWhatIf(base, adds) : base;
  const nowMicros = ctx.timestamp.microsSinceUnixEpoch;
  const chosen = solve(strategy, requests, resources, { policy: policy as Policy, nowMicros });
  const fcfs = solve('fcfs', requests, resources, { policy: policy as Policy, nowMicros });
  const suitability = solve('suitability', requests, resources, { policy: policy as Policy, nowMicros });
  let summary = `${policy} ${chosen.method} search. FCFS serves ${fcfs.assignments.length}. Suitability serves ${suitability.assignments.length}. ${AGING_RULE}`;
  if (adds.length > 0) {
    const without = solve('suitability', requests, base, { policy: policy as Policy, nowMicros });
    summary += ` With the added resource, suitability serves ${suitability.assignments.length} instead of ${without.assignments.length}. Estimated only.`;
  }
  const row = ctx.db.plan.insert({
    planId: 0n,
    shelterId,
    strategy,
    inputSnapshotVersion: snapshot.snapshotVersion,
    createdByRole: member.role,
    status: adds.length > 0 ? 'hypothetical' : 'proposed',
    hypothetical: adds.length > 0,
    summary,
    policy,
    method: chosen.method,
  });
  for (const request of [...ctx.db.helpRequest.iter()].filter(item => item.shelterId === shelterId)) {
    if (request.state !== 'received' && request.state !== 'acknowledged') continue;
    ctx.db.planRequestPin.insert({
      pinId: 0n,
      planId: row.planId,
      requestPk: request.requestPk,
      stateVersion: request.stateVersion,
    });
  }
  for (const resource of [...ctx.db.resource.iter()].filter(item => item.shelterId === shelterId)) {
    ctx.db.planResourcePin.insert({
      pinId: 0n,
      planId: row.planId,
      resourceId: resource.resourceId,
      version: resource.version,
    });
  }
  for (const item of chosen.assignments) {
    ctx.db.planAssignment.insert({
      rowId: 0n,
      planId: row.planId,
      requestPk: item.requestPk,
      resourceId: item.resourceId,
      units: item.units,
    });
  }
  for (const item of chosen.unmatched) {
    ctx.db.planUnmatched.insert({
      rowId: 0n,
      planId: row.planId,
      requestPk: item.requestPk,
      reason: item.reason,
    });
  }
  const after = [...ctx.db.resource.iter()].map(resource => resource.available);
  if (before.join() !== after.join()) fail('INVALID_TRANSITION');
  logEvent(ctx, shelterId, 'plan_proposed', row.planId.toString(), '', strategy);
}

export function approvePlan(
  ctx: Ctx,
  planId: bigint,
  expectedSnapshotVersion: bigint,
  approvalId: string,
) {
  if (!ID.test(approvalId)) fail('INVALID_INPUT');
  const prior = ctx.db.approvalReceipt.approvalId.find(approvalId);
  if (prior) {
    if (prior.planId !== planId) fail('INVALID_INPUT');
    return;
  }
  const plan = ctx.db.plan.planId.find(planId);
  if (!plan) fail('NOT_FOUND');
  requireMember(ctx, plan.shelterId, ['coordinator']);
  if (plan.hypothetical) fail('INVALID_INPUT');
  if (plan.status === 'approved') fail('ALREADY_APPROVED');
  if (plan.status !== 'proposed') fail('INVALID_TRANSITION');
  const snapshot = ctx.db.shelterVersion.shelterId.find(plan.shelterId);
  if (
    !snapshot ||
    snapshot.snapshotVersion !== expectedSnapshotVersion ||
    snapshot.snapshotVersion !== plan.inputSnapshotVersion
  ) {
    fail('STALE_PLAN');
  }
  for (const pin of [...ctx.db.planRequestPin.iter()].filter(item => item.planId === planId)) {
    const request = ctx.db.helpRequest.requestPk.find(pin.requestPk);
    if (!request || request.stateVersion !== pin.stateVersion) fail('STALE_PLAN');
  }
  for (const pin of [...ctx.db.planResourcePin.iter()].filter(item => item.planId === planId)) {
    const resource = ctx.db.resource.resourceId.find(pin.resourceId);
    if (!resource || resource.version !== pin.version) fail('STALE_PLAN');
  }
  const lines = [...ctx.db.planAssignment.iter()].filter(item => item.planId === planId);
  const seen = new Set<string>();
  const demand = new Map<string, number>();
  for (const line of lines) {
    const key = line.requestPk.toString();
    if (seen.has(key)) fail('INVALID_INPUT');
    seen.add(key);
    if (line.resourceId.startsWith('whatif-')) fail('INVALID_INPUT');
    const request = ctx.db.helpRequest.requestPk.find(line.requestPk);
    const resource = ctx.db.resource.resourceId.find(line.resourceId);
    if (!request || !resource) fail('NOT_FOUND');
    if (request.shelterId !== plan.shelterId || resource.shelterId !== plan.shelterId) {
      fail('WRONG_SHELTER');
    }
    if (request.state !== 'acknowledged') fail('INVALID_TRANSITION');
    if (request.quantity !== line.units) fail('INVALID_INPUT');
    const expectedKind = request.kind === 'water' ? 'water_stock' : 'charger_slot';
    if (resource.kind !== expectedKind) fail('INVALID_INPUT');
    if (request.needs === 'accessible_slot' && !resource.accessible) fail('INVALID_INPUT');
    const active = [...ctx.db.assignment.iter()].some(
      item => item.requestPk === line.requestPk && item.state === 'reserved',
    );
    if (active) fail('INVALID_TRANSITION');
    demand.set(line.resourceId, (demand.get(line.resourceId) ?? 0) + line.units);
  }
  for (const [resourceId, units] of demand) {
    const resource = ctx.db.resource.resourceId.find(resourceId);
    if (!resource || resource.available < units) fail('INSUFFICIENT_CAPACITY');
  }
  for (const [resourceId, units] of demand) {
    const resource = ctx.db.resource.resourceId.find(resourceId);
    if (!resource) fail('NOT_FOUND');
    ctx.db.resource.resourceId.update({
      ...resource,
      available: resource.available - units,
      reserved: resource.reserved + units,
      version: resource.version + 1n,
    });
  }
  for (const line of [...lines].sort((a, b) => (a.requestPk < b.requestPk ? -1 : 1))) {
    const request = ctx.db.helpRequest.requestPk.find(line.requestPk);
    if (!request) fail('NOT_FOUND');
    ctx.db.assignment.insert({
      assignmentId: 0n,
      shelterId: plan.shelterId,
      planId,
      requestPk: line.requestPk,
      resourceId: line.resourceId,
      units: line.units,
      volunteerSet: false,
      volunteerIdentity: Identity.zero(),
      state: 'reserved',
      dispatchState: 'unassigned',
      dispatchVersion: 1n,
      dueAt: UNSET_TIME,
      declineReason: '',
      openedAt: ctx.timestamp,
      deliveredAt: UNSET_TIME,
    });
    ctx.db.helpRequest.requestPk.update({
      ...request,
      state: 'assigned',
      stateVersion: request.stateVersion + 1n,
      updatedAt: ctx.timestamp,
    });
    logEvent(
      ctx,
      plan.shelterId,
      'request_assigned',
      line.requestPk.toString(),
      approvalId,
      line.resourceId,
    );
  }
  ctx.db.plan.planId.update({ ...plan, status: 'approved' });
  ctx.db.approvalReceipt.insert({
    approvalId,
    planId,
    shelterId: plan.shelterId,
    outcome: 'approved',
  });
  bump(ctx, plan.shelterId);
  logEvent(ctx, plan.shelterId, 'plan_approved', planId.toString(), approvalId, '');
}

export function rejectPlan(ctx: Ctx, planId: bigint, reasonCode: string) {
  const plan = ctx.db.plan.planId.find(planId);
  if (!plan) fail('NOT_FOUND');
  requireMember(ctx, plan.shelterId, ['coordinator']);
  if (reasonCode !== 'staff_rejected') fail('INVALID_INPUT');
  if (plan.status === 'rejected') return;
  if (plan.status !== 'proposed' && plan.status !== 'hypothetical') fail('INVALID_TRANSITION');
  ctx.db.plan.planId.update({ ...plan, status: 'rejected' });
  logEvent(ctx, plan.shelterId, 'plan_rejected', planId.toString(), reasonCode, '');
}

export function assignVolunteer(ctx: Ctx, assignmentId: bigint, volunteerIdentity: Identity) {
  const row = ctx.db.assignment.assignmentId.find(assignmentId);
  if (!row) fail('NOT_FOUND');
  requireMember(ctx, row.shelterId, ['coordinator']);
  if (row.state !== 'reserved') fail('INVALID_TRANSITION');
  const volunteer = ctx.db.member.identity.find(volunteerIdentity);
  if (
    !volunteer ||
    !volunteer.active ||
    volunteer.role !== 'volunteer' ||
    volunteer.shelterId !== row.shelterId
  ) {
    fail('INVALID_INPUT');
  }
  ctx.db.assignment.assignmentId.update({
    ...row,
    volunteerSet: true,
    volunteerIdentity,
    dispatchState: 'offered',
    dispatchVersion: row.dispatchVersion + 1n,
  });
  logEvent(ctx, row.shelterId, 'volunteer_assigned', assignmentId.toString(), '', '');
}

/**
 * Water handover consumes units once: reserved drops, available and capacityTotal stay.
 * A later dispute does not restore that water.
 * Charging marks access started: the slot stays reserved until endChargingSession.
 */
export function completeAssignment(ctx: Ctx, assignmentId: bigint) {
  const row = ctx.db.assignment.assignmentId.find(assignmentId);
  if (!row) fail('NOT_FOUND');
  const member = ctx.db.member.identity.find(ctx.sender);
  if (!member || !member.active) fail('UNAUTHORIZED');
  if (member.shelterId !== row.shelterId) fail('WRONG_SHELTER');
  const owns =
    member.role === 'volunteer' &&
    row.volunteerSet &&
    row.volunteerIdentity.equals(ctx.sender);
  if (member.role !== 'coordinator' && !owns) fail('UNAUTHORIZED');
  if (row.state === 'completed' || row.state === 'delivered') return;
  if (row.state !== 'reserved') fail('INVALID_TRANSITION');
  const request = ctx.db.helpRequest.requestPk.find(row.requestPk);
  const resource = ctx.db.resource.resourceId.find(row.resourceId);
  const shelter = ctx.db.shelter.shelterId.find(row.shelterId);
  if (!request || !resource || !shelter || resource.reserved < row.units) fail('INVALID_TRANSITION');
  const charging = resource.kind === 'charger_slot';
  if (!charging) {
    ctx.db.resource.resourceId.update({
      ...resource,
      reserved: resource.reserved - row.units,
      version: resource.version + 1n,
    });
    ctx.db.observation.insert({
      observationId: 0n,
      shelterId: row.shelterId,
      kind: 'consumption',
      resourceKind: resource.kind,
      units: row.units,
      at: ctx.timestamp,
      durationMicros: 0n,
    });
  }
  const needsConfirm = charging ? shelter.confirmCharging : shelter.confirmWater;
  const nextState = needsConfirm ? 'delivered' : 'completed';
  const duration =
    ctx.timestamp.microsSinceUnixEpoch > row.openedAt.microsSinceUnixEpoch
      ? ctx.timestamp.microsSinceUnixEpoch - row.openedAt.microsSinceUnixEpoch
      : 0n;
  ctx.db.observation.insert({
    observationId: 0n,
    shelterId: row.shelterId,
    kind: 'service',
    resourceKind: resource.kind,
    units: row.units,
    at: ctx.timestamp,
    durationMicros: duration,
  });
  ctx.db.assignment.assignmentId.update({
    ...row,
    state: nextState,
    dispatchState: 'delivered',
    deliveredAt: ctx.timestamp,
  });
  clearSharedLocation(ctx, `a:${assignmentId}`, row.shelterId);
  ctx.db.helpRequest.requestPk.update({
    ...request,
    state: nextState,
    fulfilledUnits: charging ? request.fulfilledUnits : row.units,
    stateVersion: request.stateVersion + 1n,
    updatedAt: ctx.timestamp,
  });
  bump(ctx, row.shelterId);
  logEvent(
    ctx,
    row.shelterId,
    'request_completed',
    row.requestPk.toString(),
    assignmentId.toString(),
    resource.kind,
  );
}

export function releaseAssignment(ctx: Ctx, assignmentId: bigint, reasonCode: string) {
  if (!RELEASE_REASONS.has(reasonCode)) fail('INVALID_INPUT');
  const row = ctx.db.assignment.assignmentId.find(assignmentId);
  if (!row) fail('NOT_FOUND');
  requireMember(ctx, row.shelterId, ['coordinator']);
  if (row.state === 'released') return;
  if (row.state !== 'reserved') fail('INVALID_TRANSITION');
  const request = ctx.db.helpRequest.requestPk.find(row.requestPk);
  const resource = ctx.db.resource.resourceId.find(row.resourceId);
  if (!request || !resource || resource.reserved < row.units) fail('INVALID_TRANSITION');
  ctx.db.resource.resourceId.update({
    ...resource,
    reserved: resource.reserved - row.units,
    available: resource.available + row.units,
    version: resource.version + 1n,
  });
  ctx.db.assignment.assignmentId.update({ ...row, state: 'released' });
  ctx.db.helpRequest.requestPk.update({
    ...request,
    state: 'acknowledged',
    stateVersion: request.stateVersion + 1n,
    updatedAt: ctx.timestamp,
  });
  bump(ctx, row.shelterId);
  logEvent(ctx, row.shelterId, 'request_released', row.requestPk.toString(), reasonCode, '');
}

export function cancelRequest(ctx: Ctx, requestPk: bigint, reasonCode: string) {
  const request = ctx.db.helpRequest.requestPk.find(requestPk);
  if (!request) fail('NOT_FOUND');
  const member = requireMember(ctx, request.shelterId, ['resident', 'coordinator']);
  if (member.role === 'resident') {
    if (!request.residentIdentity.equals(ctx.sender)) fail('UNAUTHORIZED');
    if (reasonCode !== 'resident_cancelled') fail('INVALID_INPUT');
  } else if (!CANCEL_STAFF.has(reasonCode)) {
    fail('INVALID_INPUT');
  }
  if (request.state === 'cancelled') return;
  if (request.state === 'assigned' || request.state === 'completed') fail('INVALID_TRANSITION');
  if (request.state !== 'received' && request.state !== 'acknowledged') fail('INVALID_TRANSITION');
  ctx.db.helpRequest.requestPk.update({
    ...request,
    state: 'cancelled',
    stateVersion: request.stateVersion + 1n,
    cancelReason: reasonCode,
    updatedAt: ctx.timestamp,
  });
  bump(ctx, request.shelterId);
  logEvent(ctx, request.shelterId, 'request_cancelled', requestPk.toString(), reasonCode, '');
}

export function rejectRequest(ctx: Ctx, requestPk: bigint, reasonCode: string) {
  const request = ctx.db.helpRequest.requestPk.find(requestPk);
  if (!request) fail('NOT_FOUND');
  requireMember(ctx, request.shelterId, ['coordinator']);
  if (!REJECT_REASONS.has(reasonCode)) fail('INVALID_INPUT');
  if (request.state === 'rejected') return;
  if (request.state !== 'received') fail('INVALID_TRANSITION');
  ctx.db.helpRequest.requestPk.update({
    ...request,
    state: 'rejected',
    stateVersion: request.stateVersion + 1n,
    cancelReason: reasonCode,
    updatedAt: ctx.timestamp,
  });
  bump(ctx, request.shelterId);
  logEvent(ctx, request.shelterId, 'request_rejected', requestPk.toString(), reasonCode, '');
}

export function rememberAction(ctx: Ctx, actionId: string, subjectId: string, action: string): boolean {
  if (!ID.test(actionId)) fail('INVALID_INPUT');
  const prior = ctx.db.actionReceipt.actionId.find(actionId);
  if (prior) {
    if (prior.subjectId !== subjectId || prior.action !== action) fail('INVALID_INPUT');
    return true;
  }
  ctx.db.actionReceipt.insert({ actionId, subjectId, action });
  return false;
}

export function numbersIn(text: string): string[] {
  return text.match(/\d+/g) ?? [];
}

export function submitModelProposal(
  ctx: Ctx,
  runId: string,
  planId: bigint,
  explanation: string,
  toolTrace: string,
  outcome: string,
) {
  if (!ID.test(runId) || !MODEL_OUTCOMES.has(outcome)) fail('INVALID_INPUT');
  if (toolTrace.length > 4000 || explanation.length > 2000) fail('INVALID_INPUT');
  if (ctx.db.modelRun.runId.find(runId)) return;
  const member = ctx.db.member.identity.find(ctx.sender);
  if (!member || !member.active || member.role !== 'worker') fail('UNAUTHORIZED');
  const plan = ctx.db.plan.planId.find(planId);
  let stored = outcome;
  if (!plan || plan.shelterId !== member.shelterId || plan.hypothetical) {
    stored = 'rejected';
  } else if (outcome === 'fallback' || outcome === 'timeout') {
    if (!explanation.includes(FALLBACK_EXPLANATION)) stored = 'rejected';
  } else if (outcome === 'proposal' || outcome === 'rejected') {
    const parts = [plan.summary, plan.inputSnapshotVersion.toString(), plan.planId.toString(), toolTrace];
    for (const line of [...ctx.db.planAssignment.iter()].filter(item => item.planId === planId)) {
      parts.push(line.requestPk.toString(), line.resourceId, String(line.units));
    }
    for (const line of [...ctx.db.planUnmatched.iter()].filter(item => item.planId === planId)) {
      parts.push(line.requestPk.toString(), line.reason);
    }
    const allowed = new Set(parts.flatMap(numbersIn));
    const invented = numbersIn(explanation).some(value => !allowed.has(value));
    if (explanation.trim().length === 0 || invented) stored = 'rejected';
    if (toolTrace.startsWith('[')) {
      try {
        const parsed = JSON.parse(toolTrace) as { result?: { snapshot?: string; id?: string } }[];
        for (const item of parsed) {
          const snapshot = item.result?.snapshot;
          if (snapshot && snapshot !== ctx.db.shelterVersion.shelterId.find(member.shelterId)?.snapshotVersion.toString()) {
            stored = 'rejected';
          }
          const resourceId = item.result?.id;
          if (typeof resourceId === 'string' && resourceId.includes('-') && !ctx.db.resource.resourceId.find(resourceId)) {
            stored = 'rejected';
          }
        }
      } catch {
        stored = 'rejected';
      }
    }
  }
  ctx.db.modelRun.insert({
    runId,
    shelterId: member.shelterId,
    correlationId: planId.toString(),
    toolCalls: toolTrace,
    outcome: stored,
    explanation,
    startedAt: ctx.timestamp,
    endedAt: ctx.timestamp,
  });
  logEvent(ctx, member.shelterId, 'model_run', runId, planId.toString(), stored);
}

export function myRequests(ctx: ReadCtx) {
  return [...ctx.db.helpRequest.iter()].filter(request =>
    request.residentIdentity.equals(ctx.sender),
  );
}

const VISIBLE_DISPATCH = new Set(['offered', 'accepted', 'in_progress', 'delivered', 'overdue_review']);

export function assignmentView(ctx: ReadCtx, item: {
  assignmentId: bigint;
  requestPk: bigint;
  units: number;
  state: string;
  resourceId: string;
  dispatchState: string;
  dispatchVersion: bigint;
  declineReason: string;
  dueAt: Timestamp;
  volunteerSet: boolean;
  volunteerIdentity: Identity;
}) {
  const request = ctx.db.helpRequest.requestPk.find(item.requestPk);
  if (!request) return null;
  const resident = [...ctx.db.member.iter()].find(person =>
    person.identity.equals(request.residentIdentity),
  );
  const volunteer = item.volunteerSet
    ? [...ctx.db.member.iter()].find(person => person.identity.equals(item.volunteerIdentity))
    : undefined;
  const resource = ctx.db.resource.resourceId.find(item.resourceId);
  return {
    assignmentId: item.assignmentId,
    requestPk: item.requestPk,
    residentLabel: resident?.displayLabel ?? 'Resident',
    kind: request.kind,
    units: item.units,
    state: item.state,
    resourceId: item.resourceId,
    accessible: resource?.accessible ?? false,
    dispatchState: item.dispatchState,
    dispatchVersion: item.dispatchVersion,
    declineReason: item.declineReason,
    volunteerLabel: volunteer?.displayLabel ?? '',
    dueAt: item.dueAt,
  };
}

export function myAssignments(ctx: ReadCtx) {
  const member = ctx.db.member.identity.find(ctx.sender);
  if (!member || !member.active || member.role !== 'volunteer') return [];
  const rows = [];
  for (const item of ctx.db.assignment.iter()) {
    if (!item.volunteerSet || !item.volunteerIdentity.equals(ctx.sender)) continue;
    if (!VISIBLE_DISPATCH.has(item.dispatchState)) continue;
    const view = assignmentView(ctx, item);
    if (view) rows.push(view);
  }
  return rows;
}

export function coordinatorVolunteers(ctx: ReadCtx) {
  const member = ctx.db.member.identity.find(ctx.sender);
  if (!member || !member.active || member.role !== 'coordinator') return [];
  return [...ctx.db.member.iter()]
    .filter(person => person.shelterId === member.shelterId && person.role === 'volunteer' && person.active)
    .map(person => {
      const profile = ctx.db.volunteerProfile.identity.find(person.identity);
      const openTasks = [...ctx.db.assignment.iter()].filter(
        item =>
          item.volunteerSet &&
          item.volunteerIdentity.equals(person.identity) &&
          (item.dispatchState === 'offered' || item.dispatchState === 'accepted' || item.dispatchState === 'in_progress'),
      ).length;
      return {
        identity: person.identity,
        label: person.displayLabel,
        available: profile?.available ?? false,
        canCarryWater: profile?.canCarryWater ?? false,
        chargerEscort: profile?.chargerEscort ?? false,
        zone: profile?.zone ?? '',
        openTasks,
      };
    });
}

export function coordinatorBoard(ctx: ReadCtx) {
  const member = ctx.db.member.identity.find(ctx.sender);
  if (!member || !member.active || member.role !== 'coordinator') return [];
  const rows = [];
  for (const item of ctx.db.assignment.iter()) {
    if (item.shelterId !== member.shelterId || item.state === 'released') continue;
    const view = assignmentView(ctx, item);
    if (view) rows.push(view);
  }
  return rows;
}

export function coordinatorQueue(ctx: ReadCtx) {
  const member = ctx.db.member.identity.find(ctx.sender);
  if (!member || !member.active || member.role !== 'coordinator') return [];
  const requests = [...ctx.db.helpRequest.iter()].filter(
    request => request.shelterId === member.shelterId,
  );
  const preview = solve(
    'suitability',
    solverRequests(ctx, member.shelterId),
    solverResources(ctx, member.shelterId),
  );
  const reasons = new Map(preview.unmatched.map(item => [item.requestPk.toString(), item.reason]));
  const rows = requests.map(request => {
    let waitReason = reasons.get(request.requestPk.toString()) ?? request.state;
    if (request.state === 'acknowledged' && !reasons.has(request.requestPk.toString())) {
      waitReason = 'waiting_for_approval';
    }
    if (request.state === 'assigned') waitReason = 'assigned';
    if (request.state === 'completed') waitReason = 'completed';
    if (request.state === 'cancelled') waitReason = 'cancelled';
    if (request.state === 'rejected') waitReason = 'rejected';
    const resident = [...ctx.db.member.iter()].find(person =>
      person.identity.equals(request.residentIdentity),
    );
    return {
      requestPk: request.requestPk,
      shelterId: request.shelterId,
      clientRequestId: request.clientRequestId,
      residentLabel: resident?.displayLabel ?? 'Resident',
      kind: request.kind,
      needs: request.needs,
      quantity: request.quantity,
      state: request.state,
      stateVersion: request.stateVersion,
      receivedAt: request.receivedAt,
      waitReason,
      queueRank: 0,
      humanPriority: request.humanPriority,
      priorityReason: request.priorityReason,
      cancelReason: request.cancelReason,
      updatedAt: request.updatedAt,
      serveBy: request.serveBy,
      overdue:
        request.serveBy.microsSinceUnixEpoch > 0n &&
        request.serveBy.microsSinceUnixEpoch <= ctx.timestamp.microsSinceUnixEpoch &&
        (request.state === 'acknowledged' || request.state === 'received'),
      confirmation: request.confirmation,
    };
  });
  rows.sort((a, b) => {
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    const rank = (QUEUE_RANK[a.state] ?? 9) - (QUEUE_RANK[b.state] ?? 9);
    if (rank !== 0) return rank;
    if (a.receivedAt.microsSinceUnixEpoch < b.receivedAt.microsSinceUnixEpoch) return -1;
    if (a.receivedAt.microsSinceUnixEpoch > b.receivedAt.microsSinceUnixEpoch) return 1;
    if (a.requestPk < b.requestPk) return -1;
    if (a.requestPk > b.requestPk) return 1;
    return 0;
  });
  return rows.map((row, index) => ({ ...row, queueRank: index }));
}

export function coordinatorResources(ctx: ReadCtx) {
  const member = ctx.db.member.identity.find(ctx.sender);
  if (!member || !member.active || member.role !== 'coordinator') return [];
  return [...ctx.db.resource.iter()].filter(resource => resource.shelterId === member.shelterId);
}

export function coordinatorPlans(ctx: ReadCtx) {
  const member = ctx.db.member.identity.find(ctx.sender);
  if (!member || !member.active || member.role !== 'coordinator') return [];
  return [...ctx.db.plan.iter()].filter(plan => plan.shelterId === member.shelterId);
}

function residentLabel(ctx: ReadCtx, identity: Identity): string {
  const person = [...ctx.db.member.iter()].find(member => member.identity.equals(identity));
  return person?.displayLabel || 'Resident';
}

export function coordinatorPlanDetails(ctx: ReadCtx) {
  const member = ctx.db.member.identity.find(ctx.sender);
  if (!member || !member.active || member.role !== 'coordinator') return [];
  const live = ctx.db.shelterVersion.shelterId.find(member.shelterId);
  const liveSnapshotVersion = live?.snapshotVersion ?? 0n;
  const plans = [...ctx.db.plan.iter()].filter(plan => plan.shelterId === member.shelterId);
  const rows = [];
  for (const plan of plans) {
    const served = [...ctx.db.planAssignment.iter()].filter(line => line.planId === plan.planId);
    const unmatched = [...ctx.db.planUnmatched.iter()].filter(line => line.planId === plan.planId);
    const shared = {
      planId: plan.planId,
      strategy: plan.strategy,
      status: plan.status,
      hypothetical: plan.hypothetical,
      summary: plan.summary,
      inputSnapshotVersion: plan.inputSnapshotVersion,
      liveSnapshotVersion,
      policy: plan.policy,
      method: plan.method,
    };
    if (served.length === 0 && unmatched.length === 0) {
      rows.push({
        lineId: `${plan.planId}:plan`,
        ...shared,
        lineKind: 'plan',
        requestPk: 0n,
        resourceId: '',
        units: 0,
        reason: '',
        residentLabel: '',
        requestKind: '',
        needs: '',
      });
    }
    for (const line of served) {
      const request = ctx.db.helpRequest.requestPk.find(line.requestPk);
      rows.push({
        lineId: `${plan.planId}:served:${line.requestPk}`,
        ...shared,
        lineKind: 'served',
        requestPk: line.requestPk,
        resourceId: line.resourceId,
        units: line.units,
        reason: '',
        residentLabel: request ? residentLabel(ctx, request.residentIdentity) : 'Resident',
        requestKind: request?.kind ?? '',
        needs: request?.needs ?? '',
      });
    }
    for (const line of unmatched) {
      const request = ctx.db.helpRequest.requestPk.find(line.requestPk);
      rows.push({
        lineId: `${plan.planId}:unmatched:${line.requestPk}`,
        ...shared,
        lineKind: 'unmatched',
        requestPk: line.requestPk,
        resourceId: '',
        units: 0,
        reason: line.reason,
        residentLabel: request ? residentLabel(ctx, request.residentIdentity) : 'Resident',
        requestKind: request?.kind ?? '',
        needs: request?.needs ?? '',
      });
    }
  }
  return rows;
}

export function recentEvents(ctx: ReadCtx) {
  const member = ctx.db.member.identity.find(ctx.sender);
  if (!member || !member.active || member.role !== 'coordinator') return [];
  return [...ctx.db.event.iter()]
    .filter(item => item.shelterId === member.shelterId)
    .sort((a, b) => (a.eventId < b.eventId ? 1 : a.eventId > b.eventId ? -1 : 0))
    .slice(0, 100);
}

export function workerRequests(ctx: ReadCtx) {
  const member = ctx.db.member.identity.find(ctx.sender);
  if (!member || !member.active || member.role !== 'worker') return [];
  return [...ctx.db.helpRequest.iter()]
    .filter(request => request.shelterId === member.shelterId)
    .map(request => ({
      requestPk: request.requestPk,
      kind: request.kind,
      needs: request.needs,
      state: request.state,
      quantity: request.quantity,
      receivedAt: request.receivedAt,
      humanPriority: request.humanPriority,
      stateVersion: request.stateVersion,
    }));
}

export function workerResources(ctx: ReadCtx) {
  const member = ctx.db.member.identity.find(ctx.sender);
  if (!member || !member.active || member.role !== 'worker') return [];
  return [...ctx.db.resource.iter()].filter(resource => resource.shelterId === member.shelterId);
}
