import type { PlanDetailRow } from '../module_bindings/types.ts'

export type PlanGroup = {
  head: PlanDetailRow
  served: PlanDetailRow[]
  unmatched: PlanDetailRow[]
}

export function groupPlans(rows: readonly object[]): PlanGroup[] {
  const typed = rows as readonly PlanDetailRow[]
  const groups = new Map<string, PlanGroup>()
  for (const row of typed) {
    const key = row.planId.toString()
    const group = groups.get(key) ?? { head: row, served: [], unmatched: [] }
    group.head = row
    if (row.lineKind === 'served') group.served.push(row)
    if (row.lineKind === 'unmatched') group.unmatched.push(row)
    groups.set(key, group)
  }
  return [...groups.values()].sort((a, b) => (a.head.planId > b.head.planId ? -1 : 1))
}

export function latestPair(groups: PlanGroup[]) {
  const real = groups.filter((group) => !group.head.hypothetical && group.head.status === 'proposed')
  return {
    fcfs: real.find((group) => group.head.strategy === 'fcfs'),
    suitability: real.find((group) => group.head.strategy === 'suitability'),
  }
}

export function difference(fcfs: PlanGroup | undefined, suitability: PlanGroup | undefined): string {
  if (!fcfs || !suitability) return 'Generate both plans to see who each one treats differently.'
  const fcfsIds = new Set(fcfs.served.map((row) => row.requestPk.toString()))
  const gained = suitability.served.filter((row) => !fcfsIds.has(row.requestPk.toString()))
  if (gained.length === 0) return 'These two plans serve the same requests.'
  const names = gained.map((row) => row.residentLabel).join(', ')
  return `Suitability plan serves ${names} that first-come leaves out.`
}
