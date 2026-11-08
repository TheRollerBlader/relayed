/** Gateway/agent authority is explicit and separate from shelter membership. */
import { Identity } from 'spacetimedb';
import { SenderError, type ViewCtx, type InferSchema } from 'spacetimedb/server';
import { applyCommand, initialState, viewFor } from '../../shared/autonomy/engine';
import type { Actor, Command, State } from '../../shared/autonomy/contracts';
import { bump, type Ctx } from './logic';
import type spacetimedb from './schema';
type ReadCtx = Pick<ViewCtx<InferSchema<typeof spacetimedb>>, 'db'|'sender'>;

export function seedAutonomy(ctx: Ctx) {
  const old = ctx.db.autonomyConfig.id.find('local');
  const row = { id: 'local', gateway: ctx.env.get('GATEWAY_IDENTITY') || old?.gateway || '', agent: ctx.env.get('AGENT_IDENTITY') || old?.agent || '', bootstrapAdmin: ctx.env.get('AUTONOMY_ADMIN_IDENTITY') || old?.bootstrapAdmin || '' };
  if (old) ctx.db.autonomyConfig.id.update(row); else ctx.db.autonomyConfig.insert(row);
  if (!ctx.db.autonomyState.id.find('local')) ctx.db.autonomyState.insert({ id: 'local', json: JSON.stringify(initialState()) });
}
export function isService(ctx: ReadCtx) {
  const cfg = ctx.db.autonomyConfig.id.find('local');
  const sender = ctx.sender.toHexString();
  return Boolean(cfg && (cfg.gateway === sender || cfg.agent === sender));
}
function read(ctx: Pick<ReadCtx,'db'>): State {
  return JSON.parse(ctx.db.autonomyState.id.find('local')?.json || JSON.stringify(initialState()));
}
export function executeAutonomy(ctx: Ctx, actorJson: string, commandJson: string) {
  const cfg = ctx.db.autonomyConfig.id.find('local');
  const sender = ctx.sender.toHexString();
  if (!cfg || (sender !== cfg.gateway && sender !== cfg.agent)) throw new SenderError('UNAUTHORIZED');
  if (actorJson.length > 2000 || commandJson.length > 32000) throw new SenderError('INVALID_INPUT');
  const a = JSON.parse(actorJson) as Actor;
  const command = JSON.parse(commandJson) as Command;
  if (sender === cfg.agent && (a.kind !== 'agent' || a.id !== sender)) throw new SenderError('UNAUTHORIZED');
  if (sender === cfg.gateway && a.kind === 'agent' && command.name !== 'transcript') throw new SenderError('UNAUTHORIZED');
  if (a.kind === 'user' && a.role === 'admin' && a.id !== cfg.bootstrapAdmin) throw new SenderError('UNAUTHORIZED');
  const before = read(ctx);
  // Stock is always hydrated from the existing authoritative accounting tables.
  before.stock = {};
  for (const r of ctx.db.resource.iter()) {
    if (r.kind !== 'water_stock' && r.kind !== 'charger_slot') continue;
    before.stock[r.resourceId] = { id:r.resourceId,shelterId:r.shelterId,kind:r.kind==='water_stock'?'water':'charging',accessible:r.accessible,available:r.available,reserved:r.reserved,version:Number(r.version) };
  }
  // Membership revocation in the original coordinator tools takes effect here too.
  for (const p of Object.values(before.profiles)) {
    const m = ctx.db.member.identity.find(new Identity(p.id));
    if (m && !m.active) p.active = false;
  }
  try {
    const { state } = applyCommand(before,a,command,Number(ctx.timestamp.microsSinceUnixEpoch/1000n));
    const changedShelters = new Set<string>();
    for (const stock of Object.values(state.stock)) {
      const old = ctx.db.resource.resourceId.find(stock.id);
      if (!old || old.version !== BigInt(before.stock[stock.id].version)) throw new SenderError('STALE_VERSION');
      if (stock.available !== old.available || stock.reserved !== old.reserved) {
        if (stock.available < 0 || stock.reserved < 0) throw new SenderError('ACCOUNTING_CONFLICT');
        ctx.db.resource.resourceId.update({...old,available:stock.available,reserved:stock.reserved,version:old.version+1n});
        changedShelters.add(old.shelterId);
      }
    }
    // Server grants also drive the preserved resident/coordinator/volunteer screens.
    for (const p of Object.values(state.profiles)) {
      if (!/^[a-f0-9]{64}$/.test(p.id)) throw new SenderError('INVALID_IDENTITY');
      const identity = new Identity(p.id), old = ctx.db.member.identity.find(identity);
      const role = ['resident','volunteer','coordinator'].includes(p.role) ? p.role : 'resident';
      const member = {identity,shelterId:old?.shelterId||'shelter-a',role,displayLabel:p.label.slice(0,40),grantedBy:ctx.sender,active:p.active};
      if (old) ctx.db.member.identity.update(member); else ctx.db.member.insert(member);
    }
    for (const shelter of changedShelters) bump(ctx,shelter);
    ctx.db.autonomyState.id.update({id:'local',json:JSON.stringify(state)});
  } catch (error) {
    throw new SenderError(error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'INVALID_COMMAND');
  }
}
export function gatewaySnapshot(ctx: ReadCtx) {
  if (ctx.db.autonomyConfig.id.find('local')?.gateway !== ctx.sender.toHexString()) return [];
  const row = ctx.db.autonomyState.id.find('local');
  return row ? [row] : [];
}
export function agentSnapshot(ctx: ReadCtx) {
  if (ctx.db.autonomyConfig.id.find('local')?.agent !== ctx.sender.toHexString()) return [];
  const state = read(ctx);
  return [{id:'local',json:JSON.stringify({revision:state.revision,jobs:state.jobs,policyVersion:state.policy.version})}];
}
export function userSnapshot(ctx: ReadCtx) {
  const state = read(ctx), a: Actor = {id:ctx.sender.toHexString(),kind:'user'};
  try {return [{id:'local',json:JSON.stringify(viewFor(state,a))}]} catch {return []}
}
