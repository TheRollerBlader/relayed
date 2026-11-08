/**
 * Deterministic shelter matching. No clock, no randomness, no I/O.
 * Objectives, in order: most requests served, then constrained requests on
 * scarce accessible resources, then coordinator-set human priority, then
 * earlier server receipt, then request id.
 */

export type RequestKind = 'water' | 'charging';
export type ResourceKind = 'water_stock' | 'charger_slot';
export type Strategy = 'fcfs' | 'suitability';

export interface SolverRequest {
  requestPk: bigint;
  kind: RequestKind;
  needsAccessible: boolean;
  quantity: number;
  receivedAtMicros: bigint;
  humanPriority: number;
  state: string;
}

export interface SolverResource {
  resourceId: string;
  kind: ResourceKind;
  accessible: boolean;
  available: number;
}

export interface SolverAssignment {
  requestPk: bigint;
  resourceId: string;
  units: number;
}

export interface SolverUnmatched {
  requestPk: bigint;
  reason: 'not_acknowledged' | 'no_eligible_resource' | 'capacity_exhausted';
}

export type Policy = 'most_requests' | 'most_quantity' | 'longest_wait' | 'accessible_coverage';
export type SolveMethod = 'exact' | 'heuristic' | 'fallback';

export interface SolveOptions {
  policy?: Policy;
  nowMicros?: bigint;
  stepBudget?: number;
}

export interface SolverPlan {
  assignments: SolverAssignment[];
  unmatched: SolverUnmatched[];
  method: SolveMethod;
}

export interface WhatIfAdd {
  kind: ResourceKind;
  accessible: boolean;
  count: number;
}

const EXACT_LIMIT = 12;
const DEFAULT_STEP_BUDGET = 4096;
const THIRTY_MINUTES_MICROS = 30n * 60n * 1_000_000n;

export const AGING_RULE = 'Waiting adds 1 weight for every 30 minutes. This is a declared rule, not a claim of fairness.';

export function resourceKindFor(kind: RequestKind): ResourceKind {
  return kind === 'water' ? 'water_stock' : 'charger_slot';
}

export function applyWhatIf(
  resources: readonly SolverResource[],
  adds: readonly WhatIfAdd[],
): SolverResource[] {
  const next = resources.map(copyResource);
  adds.forEach((add, index) => {
    next.push({
      resourceId: `whatif-${index}-${add.kind}-${add.accessible ? 'accessible' : 'general'}`,
      kind: add.kind,
      accessible: add.accessible,
      available: add.count,
    });
  });
  return next;
}

export function solve(
  strategy: Strategy,
  requests: readonly SolverRequest[],
  resources: readonly SolverResource[],
  options: SolveOptions = {},
): SolverPlan {
  const acknowledged = requests
    .filter(request => request.state === 'acknowledged')
    .sort(byReceipt);
  const policy = options.policy ?? 'most_requests';
  const budget = options.stepBudget ?? DEFAULT_STEP_BUDGET;
  let chosen: SolverAssignment[];
  let method: SolveMethod;
  if (strategy === 'fcfs') {
    chosen = solveFcfs(acknowledged, resources);
    method = 'heuristic';
  } else {
    const solved = solveSuitability(acknowledged, resources, policy, options.nowMicros, budget);
    chosen = solved.assignments;
    method = solved.method;
  }
  return {
    assignments: [...chosen].sort(byAssignmentPk),
    unmatched: unmatchedFor(requests, resources, chosen),
    method,
  };
}

function solveFcfs(
  acknowledged: readonly SolverRequest[],
  resources: readonly SolverResource[],
): SolverAssignment[] {
  const left = resources.map(copyResource);
  const assignments: SolverAssignment[] = [];
  for (const request of acknowledged) {
    const slot = eligibleSlots(request, left)[0];
    if (!slot) continue;
    slot.available -= request.quantity;
    assignments.push(assignment(request, slot.resourceId));
  }
  return assignments;
}

function solveSuitability(
  acknowledged: readonly SolverRequest[],
  resources: readonly SolverResource[],
  policy: Policy,
  nowMicros: bigint | undefined,
  stepBudget: number,
): { assignments: SolverAssignment[]; method: SolveMethod } {
  const pool = acknowledged.slice(0, EXACT_LIMIT);
  const overflow = acknowledged.slice(EXACT_LIMIT);
  const exact = exactBest(pool, resources, policy, nowMicros, stepBudget);
  if (!exact) {
    return {
      assignments: greedy(acknowledged, resources, policy, nowMicros),
      method: 'fallback',
    };
  }
  if (overflow.length === 0) return { assignments: exact.assignments, method: 'exact' };
  const left = resources.map(copyResource);
  for (const item of exact.assignments) {
    const slot = left.find(resource => resource.resourceId === item.resourceId);
    if (slot) slot.available -= item.units;
  }
  const rest = solveFcfs([...overflow].sort(byConstrained), left);
  return { assignments: [...exact.assignments, ...rest], method: 'heuristic' };
}

function exactBest(
  requests: readonly SolverRequest[],
  resources: readonly SolverResource[],
  policy: Policy,
  nowMicros: bigint | undefined,
  stepBudget: number,
): { assignments: SolverAssignment[] } | null {
  let best: SolverAssignment[] | null = null;
  let bestKey: string | null = null;
  const count = requests.length;
  const masks = 1 << count;
  if (masks > stepBudget) return null;
  for (let mask = 0; mask < masks; mask += 1) {
    const subset: SolverRequest[] = [];
    for (let index = 0; index < count; index += 1) {
      if ((mask & (1 << index)) !== 0) subset.push(requests[index]);
    }
    const packed = pack(subset, resources);
    if (!packed) continue;
    const key = scoreKey(packed, requests, resources, policy, nowMicros);
    if (bestKey === null || key > bestKey) {
      best = packed;
      bestKey = key;
    }
  }
  return { assignments: best ?? [] };
}

function greedy(
  acknowledged: readonly SolverRequest[],
  resources: readonly SolverResource[],
  policy: Policy,
  nowMicros: bigint | undefined,
): SolverAssignment[] {
  const ordered = [...acknowledged].sort((a, b) => comparePolicy(a, b, policy, nowMicros));
  return solveFcfs(ordered, resources);
}

function comparePolicy(
  a: SolverRequest,
  b: SolverRequest,
  policy: Policy,
  nowMicros: bigint | undefined,
): number {
  if (policy === 'most_quantity' && a.quantity !== b.quantity) return b.quantity - a.quantity;
  if (policy === 'longest_wait' || policy === 'accessible_coverage') {
    const age = ageWeight(b, nowMicros) - ageWeight(a, nowMicros);
    if (age !== 0) return age;
  }
  if (policy === 'accessible_coverage' && a.needsAccessible !== b.needsAccessible) {
    return a.needsAccessible ? -1 : 1;
  }
  return byConstrained(a, b);
}

function pack(
  subset: readonly SolverRequest[],
  resources: readonly SolverResource[],
): SolverAssignment[] | null {
  const left = resources.map(copyResource);
  const assignments: SolverAssignment[] = [];
  for (const request of [...subset].sort(byConstrained)) {
    const slots = eligibleSlots(request, left);
    slots.sort((a, b) => preference(request, a, b));
    const slot = slots[0];
    if (!slot) return null;
    slot.available -= request.quantity;
    assignments.push(assignment(request, slot.resourceId));
  }
  return assignments;
}

function preference(
  request: SolverRequest,
  a: SolverResource,
  b: SolverResource,
): number {
  if (!request.needsAccessible && a.accessible !== b.accessible) {
    return a.accessible ? 1 : -1;
  }
  return a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0;
}

function eligibleSlots(
  request: SolverRequest,
  resources: readonly SolverResource[],
): SolverResource[] {
  return resources
    .filter(
      resource =>
        resource.kind === resourceKindFor(request.kind) &&
        (!request.needsAccessible || resource.accessible) &&
        resource.available >= request.quantity,
    )
    .sort((a, b) => (a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0));
}

function unmatchedFor(
  requests: readonly SolverRequest[],
  resources: readonly SolverResource[],
  assignments: readonly SolverAssignment[],
): SolverUnmatched[] {
  const served = new Set(assignments.map(item => item.requestPk.toString()));
  const unmatched: SolverUnmatched[] = [];
  for (const request of [...requests].sort(byReceipt)) {
    if (request.state !== 'received' && request.state !== 'acknowledged') continue;
    if (request.state === 'received') {
      unmatched.push({ requestPk: request.requestPk, reason: 'not_acknowledged' });
      continue;
    }
    if (served.has(request.requestPk.toString())) continue;
    const qualifies = resources.some(
      resource =>
        resource.kind === resourceKindFor(request.kind) &&
        (!request.needsAccessible || resource.accessible),
    );
    unmatched.push({
      requestPk: request.requestPk,
      reason: qualifies ? 'capacity_exhausted' : 'no_eligible_resource',
    });
  }
  return unmatched;
}

export function ageWeight(request: SolverRequest, nowMicros: bigint | undefined): number {
  if (nowMicros === undefined || nowMicros <= request.receivedAtMicros) return request.humanPriority;
  const steps = Number((nowMicros - request.receivedAtMicros) / THIRTY_MINUTES_MICROS);
  return request.humanPriority + steps;
}

function scoreKey(
  assignments: readonly SolverAssignment[],
  requests: readonly SolverRequest[],
  resources: readonly SolverResource[],
  policy: Policy,
  nowMicros: bigint | undefined,
): string {
  const byId = new Map(resources.map(resource => [resource.resourceId, resource]));
  const rank = new Map(requests.map((request, index) => [request.requestPk.toString(), index]));
  let quantity = 0;
  let accessibleServed = 0;
  let aged = 0;
  let suitability = 0;
  let priority = 0;
  let earliness = 0;
  for (const item of assignments) {
    const request = requests.find(candidate => candidate.requestPk === item.requestPk);
    const resource = byId.get(item.resourceId);
    if (!request || !resource) continue;
    quantity += item.units;
    if (request.needsAccessible && resource.accessible) {
      suitability += 2;
      accessibleServed += 1;
    }
    if (!request.needsAccessible && !resource.accessible) suitability += 1;
    const weight = ageWeight(request, nowMicros);
    aged += weight;
    priority += request.humanPriority;
    earliness += requests.length - (rank.get(request.requestPk.toString()) ?? 0);
  }
  const primary =
    policy === 'most_quantity'
      ? quantity
      : policy === 'longest_wait'
        ? aged
        : policy === 'accessible_coverage'
          ? accessibleServed
          : assignments.length;
  const ids = assignments
    .map(item => item.requestPk)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .join(',');
  return [
    pad(primary),
    pad(assignments.length),
    pad(quantity),
    pad(accessibleServed),
    pad(aged),
    pad(suitability),
    pad(priority),
    pad(earliness),
    ids,
  ].join('|');
}

function pad(value: number): string {
  return value.toString().padStart(6, '0');
}

function assignment(request: SolverRequest, resourceId: string): SolverAssignment {
  return { requestPk: request.requestPk, resourceId, units: request.quantity };
}

function copyResource(resource: SolverResource): SolverResource {
  return { ...resource };
}

function byReceipt(a: SolverRequest, b: SolverRequest): number {
  if (a.receivedAtMicros < b.receivedAtMicros) return -1;
  if (a.receivedAtMicros > b.receivedAtMicros) return 1;
  if (a.requestPk < b.requestPk) return -1;
  if (a.requestPk > b.requestPk) return 1;
  return 0;
}

function byConstrained(a: SolverRequest, b: SolverRequest): number {
  if (a.needsAccessible !== b.needsAccessible) return a.needsAccessible ? -1 : 1;
  if (a.humanPriority !== b.humanPriority) return b.humanPriority - a.humanPriority;
  return byReceipt(a, b);
}

function byAssignmentPk(a: SolverAssignment, b: SolverAssignment): number {
  if (a.requestPk < b.requestPk) return -1;
  if (a.requestPk > b.requestPk) return 1;
  return 0;
}
