export type LocalStatus = 'saved_on_device' | 'sending' | 'delivered' | 'not_delivered';

export interface OutboxItem {
  clientRequestId: string;
  ownerIdentity: string;
  shelterId: string;
  kind: string;
  needs: string[];
  quantity: number;
  clientCreatedAt: string;
  savedAtMs: number;
  status: LocalStatus;
  confirmedStateVersion: number;
  notice: string;
}

export interface OutboxStore {
  get(clientRequestId: string): OutboxItem | undefined;
  put(item: OutboxItem): void;
  all(): OutboxItem[];
}

export class MemoryOutboxStore implements OutboxStore {
  private readonly rows = new Map<string, OutboxItem>();

  get(clientRequestId: string): OutboxItem | undefined {
    const row = this.rows.get(clientRequestId);
    return row ? { ...row, needs: [...row.needs] } : undefined;
  }

  put(item: OutboxItem): void {
    this.rows.set(item.clientRequestId, { ...item, needs: [...item.needs] });
  }

  all(): OutboxItem[] {
    return [...this.rows.values()].map(item => ({ ...item, needs: [...item.needs] }));
  }
}

const SAVED = 'Saved on this device. Not delivered yet.';
const ASK_STAFF = 'Not delivered. Please ask staff in person.';

export function enqueue(
  store: OutboxStore,
  input: Omit<OutboxItem, 'status' | 'confirmedStateVersion' | 'notice'>,
): OutboxItem {
  const existing = store.get(input.clientRequestId);
  if (existing) return existing;
  const item: OutboxItem = {
    ...input,
    status: 'saved_on_device',
    confirmedStateVersion: 0,
    notice: SAVED,
  };
  store.put(item);
  return item;
}

export function beginSend(store: OutboxStore, clientRequestId: string): OutboxItem {
  const item = required(store, clientRequestId);
  if (item.status === 'delivered' || item.status === 'not_delivered') return item;
  const sending: OutboxItem = { ...item, status: 'sending', notice: SAVED };
  store.put(sending);
  return sending;
}

export function markUnknown(store: OutboxStore, clientRequestId: string): OutboxItem {
  const item = required(store, clientRequestId);
  if (item.status === 'delivered') return item;
  const saved: OutboxItem = { ...item, status: 'saved_on_device', notice: SAVED };
  store.put(saved);
  return saved;
}

export function markDelivered(
  store: OutboxStore,
  clientRequestId: string,
  stateVersion: number,
): OutboxItem {
  const item = required(store, clientRequestId);
  if (stateVersion < item.confirmedStateVersion) return item;
  const delivered: OutboxItem = {
    ...item,
    status: 'delivered',
    confirmedStateVersion: stateVersion,
    notice: 'Delivered.',
  };
  store.put(delivered);
  return delivered;
}

export function applyServerVersion(
  store: OutboxStore,
  clientRequestId: string,
  stateVersion: number,
  notice: string,
): OutboxItem | undefined {
  const item = store.get(clientRequestId);
  if (!item || stateVersion <= item.confirmedStateVersion) return item;
  const next: OutboxItem = {
    ...item,
    status: 'delivered',
    confirmedStateVersion: stateVersion,
    notice,
  };
  store.put(next);
  return next;
}

export function expireUndelivered(
  store: OutboxStore,
  nowMs: number,
  windowMs: number,
): OutboxItem[] {
  const expired: OutboxItem[] = [];
  for (const item of store.all()) {
    if (item.status === 'delivered' || item.status === 'not_delivered') continue;
    if (nowMs - item.savedAtMs < windowMs) continue;
    const next: OutboxItem = { ...item, status: 'not_delivered', notice: ASK_STAFF };
    store.put(next);
    expired.push(next);
  }
  return expired;
}

export function pending(store: OutboxStore): OutboxItem[] {
  return store.all().filter(item => item.status === 'saved_on_device' || item.status === 'sending');
}

export function pendingFor(store: OutboxStore, ownerIdentity: string): OutboxItem[] {
  return pending(store).filter(item => item.ownerIdentity === ownerIdentity);
}

function required(store: OutboxStore, clientRequestId: string): OutboxItem {
  const item = store.get(clientRequestId);
  if (!item) throw new Error('NOT_FOUND');
  return item;
}

export interface AsyncOutboxStore {
  get(clientRequestId: string): Promise<OutboxItem | undefined>;
  put(item: OutboxItem): Promise<void>;
  all(): Promise<OutboxItem[]>;
  clear(): Promise<void>;
}

export function noteConflict(store: OutboxStore, clientRequestId: string): OutboxItem {
  const item = required(store, clientRequestId);
  const next: OutboxItem = { ...item, status: 'saved_on_device', notice: 'IDEMPOTENCY_CONFLICT' };
  store.put(next);
  return next;
}

export function noteRefused(store: OutboxStore, clientRequestId: string, code: string): OutboxItem {
  const item = required(store, clientRequestId);
  if (item.status === 'delivered') return item;
  const next: OutboxItem = { ...item, status: 'saved_on_device', notice: `REFUSED:${code}` };
  store.put(next);
  return next;
}

export function noteChecking(store: OutboxStore, clientRequestId: string): OutboxItem {
  const item = required(store, clientRequestId);
  if (item.status === 'delivered') return item;
  const next: OutboxItem = { ...item, status: 'saved_on_device', notice: 'CHECKING' };
  store.put(next);
  return next;
}

export function openIndexedDbOutbox(dbName = 'relayaid-outbox'): Promise<AsyncOutboxStore> {
  const factory = globalThis.indexedDB;
  if (!factory) return Promise.reject(new Error('INDEXEDDB_UNAVAILABLE'));
  return new Promise((resolve, reject) => {
    const request = factory.open(dbName, 1);
    request.onerror = () => reject(request.error ?? new Error('INDEXEDDB_UNAVAILABLE'));
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('outbox')) {
        db.createObjectStore('outbox', { keyPath: 'clientRequestId' });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      const done = <T>(query: IDBRequest<T>) =>
        new Promise<T>((resolveQuery, rejectQuery) => {
          query.onsuccess = () => resolveQuery(query.result);
          query.onerror = () => rejectQuery(query.error ?? new Error('INDEXEDDB_UNAVAILABLE'));
        });
      resolve({
        async get(clientRequestId) {
          const query = db.transaction('outbox', 'readonly').objectStore('outbox').get(clientRequestId);
          return done<OutboxItem | undefined>(query);
        },
        async put(item) {
          const tx = db.transaction('outbox', 'readwrite');
          const completed = new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error??new Error('STORAGE_FAILED'));tx.onerror=()=>reject(tx.error??new Error('STORAGE_FAILED'))});
          tx.objectStore('outbox').put(item);
          await completed;
        },
        async all() {
          const query = db.transaction('outbox', 'readonly').objectStore('outbox').getAll();
          return done<OutboxItem[]>(query);
        },
        async clear() {
          const query = db.transaction('outbox', 'readwrite').objectStore('outbox').clear();
          await done(query);
        },
      });
    };
  });
}
