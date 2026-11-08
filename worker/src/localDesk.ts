import { applyWhatIf, solve, type SolverRequest, type SolverResource } from '../../spacetimedb/src/solver.ts';

const STOCK: SolverResource[] = [
  { resourceId: 'water-a', kind: 'water_stock', accessible: false, available: 2 },
  { resourceId: 'charge-general-a', kind: 'charger_slot', accessible: false, available: 1 },
  { resourceId: 'charge-access-a', kind: 'charger_slot', accessible: true, available: 1 },
  { resourceId: 'water-b', kind: 'water_stock', accessible: false, available: 6 },
  { resourceId: 'charge-access-b', kind: 'charger_slot', accessible: true, available: 1 },
];

const REQUESTS: SolverRequest[] = [];

export async function executeLocalTool(
  shelterId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const here = STOCK.filter((row) => row.resourceId.endsWith(shelterId === 'shelter-b' ? '-b' : '-a'));
  if (name === 'list_stalled_requests') return [];
  if (name === 'list_resources') {
    return here.map((row) => ({
      id: row.resourceId,
      kind: row.kind,
      available: row.available,
      reserved: 0,
    }));
  }
  if (name === 'list_volunteer_availability') return { can_carry_water: 1, charger_escort: 1 };
  if (name === 'list_transfer_offers' || name === 'read_transfer_possibilities') return [];
  if (name === 'run_plan' || name === 'run_what_if') {
    let stock = here;
    if (name === 'run_what_if') {
      const count = typeof args.count === 'number' ? args.count : Number(args.count);
      const add = Number.isInteger(count) && count >= 1 && count <= 20 ? count : 2;
      stock = applyWhatIf(stock, [{ kind: 'water_stock', accessible: false, count: add }]);
    }
    const strategy = args.strategy === 'fcfs' ? 'fcfs' : 'suitability';
    const plan = solve(strategy, REQUESTS, stock, { nowMicros: BigInt(Date.now()) * 1000n });
    return {
      served: plan.assignments.length,
      method: plan.method,
      snapshot: 'local',
      hypothetical: name === 'run_what_if',
    };
  }
  if (name === 'submit_bottleneck_proposal') return { accepted: true };
  return { error: 'UNKNOWN_TOOL' };
}
