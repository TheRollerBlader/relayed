import { FALLBACK_EXPLANATION } from '../../shared/messages.ts';

export const TOOL_NAMES = [
  'list_stalled_requests',
  'list_resources',
  'list_volunteer_availability',
  'list_transfer_offers',
  'read_transfer_possibilities',
  'run_plan',
  'run_what_if',
  'submit_bottleneck_proposal',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export interface ToolDecision {
  ok: boolean;
  code: string;
}

export interface Snapshot {
  resourceIds: readonly string[];
  requestIds: readonly string[];
  snapshotVersion: string;
}

export function checkTool(
  configuredShelterId: string,
  name: string,
  args: unknown,
  snapshot?: Snapshot,
): ToolDecision {
  if (!TOOL_NAMES.includes(name as ToolName)) return { ok: false, code: 'UNKNOWN_TOOL' };
  if (!args || typeof args !== 'object') return { ok: false, code: 'INVALID_INPUT' };
  const record = args as Record<string, unknown>;
  if (typeof record.shelter_id === 'string' && record.shelter_id !== configuredShelterId) {
    return { ok: false, code: 'WRONG_SHELTER' };
  }
  if (
    name === 'run_plan' &&
    record.strategy !== undefined &&
    record.strategy !== 'fcfs' &&
    record.strategy !== 'suitability'
  ) {
    return { ok: false, code: 'INVALID_INPUT' };
  }
  if (name === 'run_what_if') {
    const change = record.change;
    if (change !== undefined && change !== 'transfer' && change !== 'add_volunteer' && change !== 'add_charger') {
      return { ok: false, code: 'INVALID_INPUT' };
    }
    if (change === 'transfer' && record.count !== undefined) {
      const count = typeof record.count === 'number' ? record.count : Number(record.count);
      if (!Number.isInteger(count) || count < 1 || count > 20) return { ok: false, code: 'INVALID_INPUT' };
    }
  }
  if (name === 'read_transfer_possibilities' && (record.names || record.residents)) {
    return { ok: false, code: 'INVALID_INPUT' };
  }
  if (name === 'submit_bottleneck_proposal') {
    if (record.explanation !== undefined && typeof record.explanation !== 'string') {
      return { ok: false, code: 'INVALID_INPUT' };
    }
    if (typeof record.explanation === 'string' && record.explanation.length > 2000) {
      return { ok: false, code: 'INVALID_INPUT' };
    }
  }
  if (snapshot) {
    if (typeof record.snapshot_version === 'string' && record.snapshot_version !== snapshot.snapshotVersion) {
      return { ok: false, code: 'STALE_PLAN' };
    }
    if (typeof record.resource_id === 'string' && !snapshot.resourceIds.includes(record.resource_id)) {
      return { ok: false, code: 'NOT_FOUND' };
    }
    if (typeof record.request_id === 'string' && !snapshot.requestIds.includes(record.request_id)) {
      return { ok: false, code: 'NOT_FOUND' };
    }
  }
  return { ok: true, code: 'OK' };
}

export interface WorkerEnv {
  NEMOTRON_BASE_URL?: string;
  NEMOTRON_API_KEY?: string;
  NEMOTRON_MODEL?: string;
  RELAYAID_SHELTER_ID?: string;
  SPACETIME_URI?: string;
  SPACETIME_DB_NAME?: string;
  SPACETIME_TOKEN?: string;
}

export function fallbackResult(shelterId: string) {
  return {
    shelterId,
    nemotron: false,
    outcome: 'fallback' as const,
    explanation: FALLBACK_EXPLANATION,
  };
}

export function modelConfigured(env: WorkerEnv): boolean {
  return Boolean(env.NEMOTRON_BASE_URL && env.NEMOTRON_API_KEY && env.NEMOTRON_MODEL);
}
