import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyServerVersion,
  beginSend,
  enqueue,
  expireUndelivered,
  markDelivered,
  markUnknown,
  MemoryOutboxStore,
  pending,
  pendingFor,
} from './outbox.ts';

const input = {
  clientRequestId: 'request-001',
  ownerIdentity: 'resident-a',
  shelterId: 'shelter-a',
  kind: 'charging',
  needs: ['accessible_slot'],
  quantity: 1,
  clientCreatedAt: 'device-clock',
  savedAtMs: 1_000,
};

test('offline save stays queued across a new reader and never claims delivery', () => {
  const store = new MemoryOutboxStore();
  const saved = enqueue(store, input);
  assert.equal(saved.status, 'saved_on_device');
  assert.match(saved.notice, /Not delivered yet/);
  beginSend(store, input.clientRequestId);
  markUnknown(store, input.clientRequestId);
  const reloaded = pending(store);
  assert.equal(reloaded.length, 1);
  assert.equal(reloaded[0].status, 'saved_on_device');
  assert.equal(reloaded[0].notice.includes('Delivered'), false);
});

test('an older server version cannot move the receipt backward', () => {
  const store = new MemoryOutboxStore();
  enqueue(store, input);
  markDelivered(store, input.clientRequestId, 3);
  const kept = applyServerVersion(store, input.clientRequestId, 2, 'Seen by a person.');
  assert.equal(kept?.confirmedStateVersion, 3);
  assert.equal(kept?.notice, 'Delivered.');
  const next = applyServerVersion(store, input.clientRequestId, 4, 'Seen by a person.');
  assert.equal(next?.confirmedStateVersion, 4);
  assert.equal(next?.notice, 'Seen by a person.');
});

test('an account switch does not send the previous owner\'s request', () => {
  const store = new MemoryOutboxStore();
  enqueue(store, input);
  enqueue(store, { ...input, clientRequestId: 'request-002', ownerIdentity: 'resident-b' });
  const mine = pendingFor(store, 'resident-b');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].clientRequestId, 'request-002');
  assert.equal(pendingFor(store, 'resident-a').some(item => item.ownerIdentity === 'resident-b'), false);
});

test('expiry tells the resident to ask staff and does not say the request is queued', () => {
  const store = new MemoryOutboxStore();
  enqueue(store, input);
  const [expired] = expireUndelivered(store, 20_000, 5_000);
  assert.equal(expired.status, 'not_delivered');
  assert.match(expired.notice, /Please ask staff in person/);
  assert.equal(pending(store).length, 0);
});
