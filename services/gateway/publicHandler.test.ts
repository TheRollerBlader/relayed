import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

process.env.AUTONOMY_STATE_FILE = join(mkdtempSync(join(tmpdir(), 'relayaid-')), 'state.json')
delete process.env.NETLIFY
delete process.env.AWS_LAMBDA_FUNCTION_NAME
delete process.env.LAMBDA_TASK_ROOT
delete process.env.NEMOTRON_API_KEY
delete process.env.LIVEKIT_URL
delete process.env.LIVEKIT_API_KEY
delete process.env.LIVEKIT_API_SECRET
delete process.env.VAPID_PUBLIC_KEY
process.env.OUTBOX_MASTER_KEY = 'unit-test-outbox-master-key'

const { handlePublicRequest } = await import('./publicHandler.ts')

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

async function call(path: string, body?: unknown, token?: string) {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (token) headers.set('authorization', `Bearer ${token}`)
  const response = await handlePublicRequest(new Request(`http://local${path}`, {
    method: body === undefined && !path.includes('?') ? 'GET' : path.startsWith('/api/photo?') || path === '/api/push/key' || path === '/api/session' ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }))
  return { status: response.status, body: await response.json() }
}

function post(path: string, body: unknown, token?: string) {
  return call(path, body, token)
}

test('a guest can report and cannot read someone else', async () => {
  const first = await post('/api/guest', {})
  const second = await post('/api/guest', {})
  assert.equal(first.status, 201)
  assert.match(first.body.capability, /^guest\.[a-f0-9]{64}\./)
  const session = await call('/api/session', undefined, first.body.capability)
  assert.equal(session.body.profile.role, 'resident')
  assert.equal(session.body.profile.guest, true)
  const id = 'guest-case-0001'
  const created = await post('/api/command', {
    name: 'create_case',
    operationId: 'guest-op-0001',
    expectedVersion: 0,
    body: {
      id,
      text: 'One bottle of water',
      category: 'water',
      quantity: 1,
      danger: 'no',
      location: { label: 'North Hall', source: 'manual', capturedAt: Date.now(), confirmed: true },
      confirmed: true,
      affectedPerson: 'myself',
      accessible: false,
      conversationId: id,
    },
  }, first.body.capability)
  assert.equal(created.status, 200)
  assert.equal(created.body.view.cases[0].state, 'accepted')
  assert.equal(created.body.view.cases[0].requestState, 'assigned')
  const other = await call('/api/session', undefined, second.body.capability)
  assert.equal(other.body.cases.length, 0)
})

test('too much water is left open instead of being over-reserved', async () => {
  const guest = await post('/api/guest', {})
  const created = await post('/api/command', {
    name: 'create_case',
    operationId: 'water-too-much-01',
    expectedVersion: 0,
    body: {
      id: 'water-too-much',
      text: 'Twenty bottles',
      category: 'water',
      quantity: 20,
      danger: 'no',
      location: { label: 'North Hall', source: 'manual', capturedAt: Date.now(), confirmed: true },
      confirmed: true,
      affectedPerson: 'myself',
      accessible: false,
      conversationId: 'water-too-much',
    },
  }, guest.body.capability)
  const item = created.body.view.cases[0]
  assert.equal(item.state, 'escalation_needed')
  assert.notEqual(item.requestState, 'assigned')
  assert.match(created.body.view.events.map((event: { summary: string }) => event.summary).join(' '), /stock|volunteer/i)
})

test('the same command is idempotent and a changed payload conflicts', async () => {
  const guest = await post('/api/guest', {})
  const body = {
    id: 'idem-case-0001',
    text: 'One bottle',
    category: 'water',
    quantity: 1,
    danger: 'no',
    location: { label: 'North Hall', source: 'manual', capturedAt: 1, confirmed: true },
    confirmed: true,
    affectedPerson: 'myself',
    accessible: false,
    conversationId: 'idem-case-0001',
  }
  const command = { name: 'create_case', operationId: 'idem-op-000001', expectedVersion: 0, body }
  const first = await post('/api/command', command, guest.body.capability)
  const again = await post('/api/command', command, guest.body.capability)
  assert.equal(first.status, 200)
  assert.equal(again.status, 200)
  assert.equal(again.body.view.cases.filter((item: { id: string }) => item.id === body.id).length, 1)
  const changed = await post('/api/command', { ...command, body: { ...body, quantity: 2 } }, guest.body.capability)
  assert.equal(changed.status, 400)
  assert.equal(changed.body.error, 'IDEMPOTENCY_CONFLICT')
})

test('declared danger stays unverified and a fire case is not given to a volunteer', async () => {
  const guest = await post('/api/guest', {})
  await post('/api/command', {
    name: 'set_consent',
    operationId: 'consent-fire-0001',
    body: { type: 'precise_location', granted: true },
  }, guest.body.capability)
  const created = await post('/api/command', {
    name: 'create_case',
    operationId: 'fire-op-0000001',
    expectedVersion: 0,
    body: {
      id: 'fire-case-0001',
      text: 'Smoke in the hallway next door',
      category: 'fire',
      quantity: 1,
      danger: 'yes',
      location: { label: 'Hallway', source: 'gps', capturedAt: Date.now(), confirmed: true, lat: 32.78, lon: -96.8, accuracyM: 20 },
      confirmed: true,
      affectedPerson: 'someone_else',
      conversationId: 'fire-case-0001',
    },
  }, guest.body.capability)
  const item = created.body.view.cases.find((row: { id: string }) => row.id === 'fire-case-0001')
  assert.equal(item.priority, 'urgent_unverified')
  assert.equal(item.assignmentId, '')
  const summaries = created.body.view.events.filter((event: { caseId: string }) => event.caseId === 'fire-case-0001').map((event: { summary: string }) => event.summary)
  assert.match(summaries.join(' '), /synthetic responder sandbox/i)
  assert.equal(created.body.view.tasks.filter((task: { caseId: string }) => task.caseId === 'fire-case-0001').length, 0)
})

test('a gps point is dropped until precise location consent is on', async () => {
  const guest = await post('/api/guest', {})
  const created = await post('/api/command', {
    name: 'create_case',
    operationId: 'gps-op-00000001',
    expectedVersion: 0,
    body: {
      id: 'gps-case-0001',
      text: 'Need a look at the porch',
      category: 'flood',
      quantity: 1,
      danger: 'unsure',
      location: { label: 'Porch', source: 'gps', capturedAt: Date.now(), confirmed: true, lat: 32.78, lon: -96.8, accuracyM: 12 },
      confirmed: true,
      affectedPerson: 'myself',
      conversationId: 'gps-case-0001',
    },
  }, guest.body.capability)
  const item = created.body.view.cases[0]
  assert.equal(item.priority, 'urgent_unverified')
  assert.equal(item.location, null)
})

test('text chat reads the report back and ending it leaves the case open', async () => {
  const guest = await post('/api/guest', {})
  const created = await post('/api/command', {
    name: 'create_case',
    operationId: 'talk-case-op-01',
    expectedVersion: 0,
    body: {
      id: 'talk-case-0001',
      text: 'One bottle of water',
      category: 'water',
      quantity: 1,
      danger: 'no',
      location: { label: 'North Hall', source: 'manual', capturedAt: 1, confirmed: true },
      confirmed: true,
      affectedPerson: 'myself',
      accessible: false,
      conversationId: 'talk-case-0001',
    },
  }, guest.body.capability)
  const version = created.body.view.cases[0].version
  const started = await post('/api/command', {
    name: 'start_call',
    operationId: 'talk-start-0001',
    caseId: 'talk-case-0001',
    expectedVersion: version,
    body: { callId: 'talk-call-0001', deviceId: 'device-0001' },
  }, guest.body.capability)
  assert.equal(started.status, 200)
  const media = await post('/api/media/token', { callId: 'talk-call-0001', deviceId: 'device-0001' }, guest.body.capability)
  assert.equal(media.body.mode, 'text')
  assert.equal(media.body.recording, false)
  const talked = await post('/api/talk', { callId: 'talk-call-0001', text: 'We need one bottle' }, guest.body.capability)
  assert.match(talked.body.caption, /AI unavailable/i)
  assert.equal(talked.body.view.calls[0].transcript.length, 2)
  const ended = await post('/api/command', {
    name: 'end_call',
    operationId: 'talk-end-000001',
    caseId: 'talk-case-0001',
    expectedVersion: talked.body.view.cases[0].version,
    body: { callId: 'talk-call-0001', deviceId: 'device-0001' },
  }, guest.body.capability)
  assert.equal(ended.status, 200)
  assert.notEqual(ended.body.view.cases[0].state, 'resolved')
  assert.equal(ended.body.view.calls[0].state, 'ended')
})

test('photos stay with the owner and bad uploads are refused', async () => {
  const owner = await post('/api/guest', {})
  const other = await post('/api/guest', {})
  await post('/api/command', {
    name: 'create_case',
    operationId: 'photo-op-000001',
    expectedVersion: 0,
    body: {
      id: 'photo-case-001',
      text: 'Supplies on the table',
      category: 'food',
      quantity: 1,
      danger: 'no',
      location: { label: 'Table', source: 'manual', capturedAt: 1, confirmed: true },
      confirmed: true,
      affectedPerson: 'myself',
      conversationId: 'photo-case-001',
    },
  }, owner.body.capability)
  const bad = await post('/api/photo', { caseId: 'photo-case-001', image: 'not-an-image' }, owner.body.capability)
  assert.equal(bad.status, 400)
  const saved = await post('/api/photo', { caseId: 'photo-case-001', image: png }, owner.body.capability)
  assert.equal(saved.status, 200)
  const mine = await call('/api/photo?caseId=photo-case-001', undefined, owner.body.capability)
  assert.equal(mine.body.image, png)
  const theirs = await call('/api/photo?caseId=photo-case-001', undefined, other.body.capability)
  assert.equal(theirs.status, 404)
})

test('a guest cannot grant themselves a staff role', async () => {
  const guest = await post('/api/guest', {})
  const session = await call('/api/session', undefined, guest.body.capability)
  const refused = await post('/api/command', {
    name: 'admin_grant',
    operationId: 'grant-self-0001',
    body: { userId: session.body.profile.id, role: 'admin', orgId: '', skills: [], skillsVerified: false },
  }, guest.body.capability)
  assert.equal(refused.status, 401)
  assert.equal(refused.body.error, 'UNAUTHORIZED')
})

test('push stays in the app until keys are configured', async () => {
  const key = await call('/api/push/key')
  assert.equal(key.status, 200)
  assert.equal(key.body.enabled, false)
})
