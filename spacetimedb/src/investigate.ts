import type { Identity } from 'spacetimedb';
import { fail, logEvent, requireMember, type Ctx } from './logic';
import { FALLBACK_EXPLANATION } from './logic';
import { applyWhatIf, solve } from './solver';

export interface InvestigationTrace {
  snapshotVersion: bigint;
  trace: { id: string; tool: string; result: unknown }[];
  explanation: string;
}

export function buildFallbackTrace(ctx: Ctx, shelterId: string): InvestigationTrace {
  const snapshot = ctx.db.shelterVersion.shelterId.find(shelterId);
  if (!snapshot) fail('NOT_FOUND');
  const stalled = [...ctx.db.helpRequest.iter()]
    .filter(request => request.shelterId === shelterId && (request.state === 'acknowledged' || request.state === 'received'))
    .map(request => ({
      id: request.requestPk.toString(),
      kind: request.kind,
      need: request.needs,
      quantity: request.quantity,
      state: request.state,
    }));
  const resources = [...ctx.db.resource.iter()]
    .filter(resource => resource.shelterId === shelterId)
    .map(resource => ({
      id: resource.resourceId,
      kind: resource.kind,
      available: resource.available,
      reserved: resource.reserved,
      version: resource.version.toString(),
    }));
  const profiles = [...ctx.db.volunteerProfile.iter()].filter(profile => profile.shelterId === shelterId && profile.available);
  const volunteers = {
    can_carry_water: profiles.filter(profile => profile.canCarryWater).length,
    charger_escort: profiles.filter(profile => profile.chargerEscort).length,
  };
  const transfers = [...ctx.db.transfer.iter()]
    .filter(row => row.sourceShelterId === shelterId || row.destShelterId === shelterId)
    .map(row => ({
      id: row.transferId.toString(),
      kind: row.kind,
      quantity: row.quantityOffered || row.quantityRequested,
      state: row.state,
    }));
  const requests = [...ctx.db.helpRequest.iter()]
    .filter(request => request.shelterId === shelterId)
    .map(request => ({
      requestPk: request.requestPk,
      kind: request.kind === 'charging' ? 'charging' as const : 'water' as const,
      needsAccessible: request.needs === 'accessible_slot',
      quantity: request.quantity,
      receivedAtMicros: request.receivedAt.microsSinceUnixEpoch,
      humanPriority: request.humanPriority,
      state: request.state,
    }));
  const stock = [...ctx.db.resource.iter()]
    .filter(resource => resource.shelterId === shelterId)
    .map(resource => ({
      resourceId: resource.resourceId,
      kind: resource.kind === 'charger_slot' ? 'charger_slot' as const : 'water_stock' as const,
      accessible: resource.accessible,
      available: resource.available,
    }));
  const plan = solve('suitability', requests, stock, { nowMicros: ctx.timestamp.microsSinceUnixEpoch });
  const whatIf = solve(
    'suitability',
    requests,
    applyWhatIf(stock, [{ kind: 'water_stock', accessible: false, count: 2 }]),
    { nowMicros: ctx.timestamp.microsSinceUnixEpoch },
  );
  const trace = [
    { id: 'r1', tool: 'list_stalled_requests', result: stalled },
    { id: 'r2', tool: 'list_resources', result: resources },
    { id: 'r3', tool: 'list_volunteer_availability', result: volunteers },
    { id: 'r4', tool: 'list_transfer_offers', result: transfers },
    { id: 'r5', tool: 'run_plan', result: { served: plan.assignments.length, method: plan.method, snapshot: snapshot.snapshotVersion.toString() } },
    { id: 'r6', tool: 'run_what_if', result: { change: 'transfer 2', served: whatIf.assignments.length, method: whatIf.method, hypothetical: true } },
  ];
  return {
    snapshotVersion: snapshot.snapshotVersion,
    trace,
    explanation: `${FALLBACK_EXPLANATION} Cited results r1 r2 r3 r4 r5 r6. Hypothetical transfer only.`,
  };
}

export function requestInvestigation(ctx: Ctx, shelterId: string, runId: string) {
  requireMember(ctx, shelterId, ['coordinator']);
  if (!/^[A-Za-z0-9._:-]{8,80}$/.test(runId)) fail('INVALID_INPUT');
  if (ctx.db.modelRun.runId.find(runId)) return;
  const built = buildFallbackTrace(ctx, shelterId);
  ctx.db.modelRun.insert({
    runId,
    shelterId,
    correlationId: built.snapshotVersion.toString(),
    toolCalls: JSON.stringify(built.trace),
    outcome: 'fallback',
    explanation: built.explanation,
    startedAt: ctx.timestamp,
    endedAt: ctx.timestamp,
  });
  logEvent(ctx, shelterId, 'model_run', runId, built.snapshotVersion.toString(), 'fallback');
}

export function coordinatorModelRuns(ctx: { db: Ctx['db']; sender: Identity }) {
  const member = ctx.db.member.identity.find(ctx.sender);
  if (!member || member.role !== 'coordinator') return [];
  return [...ctx.db.modelRun.iter()].filter(run => run.shelterId === member.shelterId);
}
