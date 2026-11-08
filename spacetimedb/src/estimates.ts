import type { Identity } from 'spacetimedb';
import type { Ctx } from './logic';

export const MIN_SAMPLE = 5;

export function summarize(values: readonly number[]) {
  const sampleSize = values.length;
  if (sampleSize < MIN_SAMPLE) {
    return {
      status: 'unknown' as const,
      low: 0,
      high: 0,
      sampleSize,
      label: 'Unknown: not enough data yet.',
    };
  }
  const low = Math.min(...values);
  const high = Math.max(...values);
  return {
    status: 'estimated' as const,
    low,
    high,
    sampleSize,
    label: `Estimated range ${low} to ${high} from ${sampleSize} observations. This is not an arrival time.`,
  };
}

export function coordinatorEstimates(ctx: { db: Ctx['db']; sender: Identity }) {
  const member = ctx.db.member.identity.find(ctx.sender);
  if (!member || member.role !== 'coordinator') return [];
  const grouped = new Map<string, number[]>();
  for (const row of ctx.db.observation.iter()) {
    if (row.shelterId !== member.shelterId || row.kind !== 'consumption') continue;
    const list = grouped.get(row.resourceKind) ?? [];
    list.push(row.units);
    grouped.set(row.resourceKind, list);
  }
  if (grouped.size === 0) {
    return [{
      estimateId: `${member.shelterId}:none`,
      shelterId: member.shelterId,
      resourceKind: 'water_stock',
      sampleSize: 0,
      status: 'unknown',
      low: 0,
      high: 0,
      label: 'Unknown: not enough data yet.',
    }];
  }
  return [...grouped.entries()].map(([resourceKind, values]) => {
    const summary = summarize(values);
    return {
      estimateId: `${member.shelterId}:${resourceKind}`,
      shelterId: member.shelterId,
      resourceKind,
      sampleSize: summary.sampleSize,
      status: summary.status,
      low: summary.low,
      high: summary.high,
      label: summary.label,
    };
  });
}
