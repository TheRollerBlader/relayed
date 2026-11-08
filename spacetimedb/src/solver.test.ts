import assert from 'node:assert/strict';
import test from 'node:test';
import { summarize } from './estimates.ts';
import { applyWhatIf, solve, type SolverRequest, type SolverResource } from './solver.ts';

const resources: SolverResource[] = [
  { resourceId: 'charge-access-a', kind: 'charger_slot', accessible: true, available: 1 },
  { resourceId: 'charge-general-a', kind: 'charger_slot', accessible: false, available: 1 },
  { resourceId: 'water-a', kind: 'water_stock', accessible: false, available: 2 },
];

function request(partial: Partial<SolverRequest> & Pick<SolverRequest, 'requestPk' | 'kind'>): SolverRequest {
  return {
    needsAccessible: false,
    quantity: 1,
    receivedAtMicros: 1_000n,
    humanPriority: 0,
    state: 'acknowledged',
    ...partial,
  };
}

test('FCFS gives the earliest request the first eligible slot', () => {
  const plan = solve('fcfs', [
    request({ requestPk: 1n, kind: 'charging', receivedAtMicros: 1n }),
    request({ requestPk: 2n, kind: 'charging', needsAccessible: true, receivedAtMicros: 2n }),
  ], resources);
  assert.deepEqual(plan.assignments.map(item => [item.requestPk, item.resourceId]), [
    [1n, 'charge-access-a'],
  ]);
  assert.equal(plan.unmatched.find(item => item.requestPk === 2n)?.reason, 'capacity_exhausted');
});

test('suitability keeps the accessible slot for the constrained request', () => {
  const plan = solve('suitability', [
    request({ requestPk: 1n, kind: 'charging', receivedAtMicros: 1n }),
    request({ requestPk: 2n, kind: 'charging', needsAccessible: true, receivedAtMicros: 2n }),
  ], resources);
  const assigned = new Map(plan.assignments.map(item => [item.requestPk, item.resourceId]));
  assert.equal(assigned.get(2n), 'charge-access-a');
  assert.equal(assigned.get(1n), 'charge-general-a');
  assert.equal(plan.unmatched.length, 0);
});

test('an unacknowledged request stays unmatched and does not take capacity', () => {
  const plan = solve('suitability', [
    request({ requestPk: 1n, kind: 'charging', needsAccessible: true, state: 'received' }),
    request({ requestPk: 2n, kind: 'charging', receivedAtMicros: 2n }),
  ], resources);
  assert.equal(plan.assignments.length, 1);
  assert.equal(plan.assignments[0].requestPk, 2n);
  assert.equal(plan.unmatched.find(item => item.requestPk === 1n)?.reason, 'not_acknowledged');
});

test('water stops when stock is exhausted', () => {
  const plan = solve('fcfs', [
    request({ requestPk: 1n, kind: 'water', receivedAtMicros: 1n }),
    request({ requestPk: 2n, kind: 'water', receivedAtMicros: 2n }),
    request({ requestPk: 3n, kind: 'water', receivedAtMicros: 3n }),
  ], resources);
  assert.deepEqual(plan.assignments.map(item => item.requestPk), [1n, 2n]);
  assert.equal(plan.unmatched.find(item => item.requestPk === 3n)?.reason, 'capacity_exhausted');
});

test('what-if adds a charger without changing the original list', () => {
  const added = applyWhatIf(resources, [{ kind: 'charger_slot', accessible: true, count: 1 }]);
  assert.equal(resources.length, 3);
  const plan = solve('suitability', [
    request({ requestPk: 1n, kind: 'charging', needsAccessible: true, receivedAtMicros: 1n }),
    request({ requestPk: 2n, kind: 'charging', needsAccessible: true, receivedAtMicros: 2n }),
  ], added);
  assert.equal(plan.assignments.length, 2);
  assert.equal(plan.unmatched.length, 0);
});

test('more than 12 acknowledged requests stay feasible and labelled', () => {
  const stock = [{ resourceId: 'water-a', kind: 'water_stock' as const, accessible: false, available: 100 }];
  for (const count of [13, 20, 50]) {
    const requests = Array.from({ length: count }, (_, index) =>
      request({ requestPk: BigInt(index + 1), kind: 'water', receivedAtMicros: BigInt(index + 1) }),
    );
    const plan = solve('suitability', requests, stock);
    assert.equal(plan.assignments.length, count);
    assert.equal(plan.method, 'heuristic');
  }
});

test('a step budget below the exact search is an explicit fallback', () => {
  const plan = solve('suitability', [
    request({ requestPk: 1n, kind: 'water' }),
    request({ requestPk: 2n, kind: 'water', receivedAtMicros: 2n }),
  ], [{ resourceId: 'water-a', kind: 'water_stock', accessible: false, available: 2 }], { stepBudget: 1 });
  assert.equal(plan.method, 'fallback');
  assert.equal(plan.assignments.length, 2);
});

test('aging serves a long-waiting large household ahead of new small requests', () => {
  const now = 10n * 60n * 60n * 1_000_000n;
  const stock = [{ resourceId: 'water-a', kind: 'water_stock' as const, accessible: false, available: 5 }];
  const plan = solve('suitability', [
    request({ requestPk: 1n, kind: 'water', quantity: 5, receivedAtMicros: 1n }),
    request({ requestPk: 2n, kind: 'water', quantity: 1, receivedAtMicros: now }),
    request({ requestPk: 3n, kind: 'water', quantity: 1, receivedAtMicros: now }),
    request({ requestPk: 4n, kind: 'water', quantity: 1, receivedAtMicros: now }),
  ], stock, { policy: 'longest_wait', nowMicros: now });
  assert.deepEqual(plan.assignments.map(item => item.requestPk), [1n]);
});

test('shortage estimates stay unknown below the sample and never claim an arrival time', () => {
  assert.equal(summarize([1, 1, 1, 1]).status, 'unknown');
  const ready = summarize([1, 2, 2, 3, 4]);
  assert.equal(ready.status, 'estimated');
  assert.equal(ready.low, 1);
  assert.equal(ready.high, 4);
  assert.match(ready.label, /not an arrival time/i);
});

test('no accessible charger is no_eligible_resource, not a full general slot', () => {
  const plan = solve('fcfs', [
    request({ requestPk: 1n, kind: 'charging', needsAccessible: true }),
  ], [{ resourceId: 'charge-general-a', kind: 'charger_slot', accessible: false, available: 1 }]);
  assert.equal(plan.unmatched[0].reason, 'no_eligible_resource');
});
