import {PrivateOutbox,clearAllOutboxes} from '../../client/privateOutbox.ts'
import {api} from './gateway.ts'
import { useSyncExternalStore } from 'react'
import {
  applyServerVersion,
  beginSend,
  enqueue,
  expireUndelivered,
  markDelivered,
  noteChecking,
  noteConflict,
  noteRefused,
  pendingFor,
  type OutboxItem,
  type OutboxStore,
} from '../../client/outbox.ts'

class MemoryMirror implements OutboxStore {
  private readonly rows = new Map<string, OutboxItem>()

  get(clientRequestId: string): OutboxItem | undefined {
    const row = this.rows.get(clientRequestId)
    return row ? { ...row, needs: [...row.needs] } : undefined
  }

  put(item: OutboxItem) {
    this.rows.set(item.clientRequestId, { ...item, needs: [...item.needs] })
  }

  all(): OutboxItem[] {
    return [...this.rows.values()].map((item) => ({ ...item, needs: [...item.needs] }))
  }

  clear() {
    this.rows.clear()
  }
}

const memory = new MemoryMirror()
let durable: PrivateOutbox<OutboxItem> | null = null
let scope = ''
let ownerIdentity = ''
let epoch=0
let view: {ready:boolean;items:OutboxItem[]}={ready:false,items:[]}
const listeners = new Set<() => void>()
export function outboxScope(identity:string,shelterId:string){return `relayaid-outbox:${identity}:${shelterId}`}
function publish(ready:boolean){view={ready,items:memory.all().filter(x=>x.ownerIdentity===ownerIdentity)};listeners.forEach(x=>x())}
export function lockOutbox(){epoch++;durable?.lock();durable=null;memory.clear();scope='';ownerIdentity='';publish(false)}
export async function bindOutbox(identity:string,shelterId:string){
 if(!identity)return
 const next=outboxScope(identity,shelterId)
 if(scope===next&&view.ready)return
 lockOutbox();const generation=epoch
 try{
  const verified=await api<{ownerIdentity:string;key:string}>('/api/outbox-key')
  if(generation!==epoch||verified.ownerIdentity!==identity)return
  const store=await PrivateOutbox.unlock<OutboxItem>(identity,verified.key)
  const items=await store.all()
  if(generation!==epoch){store.lock();return}
  durable=store;ownerIdentity=identity;scope=next
  items.filter(x=>x.shelterId===shelterId).forEach(x=>memory.put(x));publish(true)
 }catch{if(generation===epoch)publish(false)}
}
export function startOutbox(){/* Never infer ownership from localStorage. */}
function subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener)}}
export function useOutbox(){return useSyncExternalStore(subscribe,()=>view,()=>view)}

async function persist(item: OutboxItem) {
  if(!durable||!view.ready||item.ownerIdentity!==ownerIdentity)throw new Error('OWNER_VERIFICATION_REQUIRED')
  const generation=epoch
  await durable.put(item)
  if(generation!==epoch)throw new Error('OWNER_VERIFICATION_REQUIRED')
  memory.put(item)
  publish(true)
}

export async function saveRequest(
  input: Omit<OutboxItem, 'status' | 'confirmedStateVersion' | 'notice' | 'ownerIdentity'> & { ownerIdentity?: string },
): Promise<OutboxItem> {
  const temporary=new MemoryMirror()
  const existing=memory.get(input.clientRequestId);if(existing)temporary.put(existing)
  const item = enqueue(temporary, { ...input, ownerIdentity: input.ownerIdentity || ownerIdentity })
  await persist(item)
  return memory.get(item.clientRequestId) ?? item
}

export async function markSending(clientRequestId: string) {
  await persist(beginSend(memory, clientRequestId))
}

export async function markChecking(clientRequestId: string) {
  await persist(noteChecking(memory, clientRequestId))
}

export async function markConflict(clientRequestId: string) {
  await persist(noteConflict(memory, clientRequestId))
}

export async function markRefused(clientRequestId: string, code: string) {
  await persist(noteRefused(memory, clientRequestId, code))
}

export async function expireNow() {
  const expired = expireUndelivered(memory, Date.now(), 12 * 60 * 60 * 1000)
  for (const item of expired) await persist(item)
}

export async function markServer(clientRequestId: string, stateVersion: number, notice: string) {
  const current = memory.get(clientRequestId)
  if (!current) return
  const next =
    current.status === 'delivered'
      ? applyServerVersion(memory, clientRequestId, stateVersion, notice)
      : markDelivered(memory, clientRequestId, stateVersion)
  if (!next) return
  await persist({ ...next, notice })
}

export function unsent(): OutboxItem[] {
  return pendingFor(memory, ownerIdentity).filter(
    (item) =>
      item.notice !== 'IDEMPOTENCY_CONFLICT' &&
      item.notice !== 'CHECKING' &&
      !item.notice.startsWith('REFUSED:'),
  )
}

export async function retryRequest(clientRequestId: string) {
  const current = memory.get(clientRequestId)
  if (!current || current.status === 'delivered') return
  await persist({
    ...current,
    status: 'saved_on_device',
    notice: 'Saved on this device. Not delivered yet.',
  })
}

export async function clearOutbox() {
  await durable?.clear()
  memory.clear()
  publish(view.ready)
}

export async function clearDeviceOutboxes(){lockOutbox();await clearAllOutboxes()}
