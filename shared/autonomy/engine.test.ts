import assert from 'node:assert/strict'
import test from 'node:test'
import { seedState } from '../../services/localAutonomy.ts'
import { applyCommand } from './engine.ts'
import { initialState, type Actor, type Command, type State } from './contracts.ts'

const user: Actor = { id: 'resident-demo-01', kind: 'user', verified: true }
const agent: Actor = { id: 'orchestrator', kind: 'agent' }

function run(state: State, actor: Actor, command: Command, now = 1_700_000_000_000) {
  return applyCommand(state, actor, command, now)
}

function boot() {
  let state = seedState(initialState())
  state = run(state, user, { name: 'register', operationId: 'register-resident-01', body: { label: 'Maya' } }).state
  return state
}

function flush(state: State, now = 1_700_000_000_000) {
  for (let index = 0; index < 6; index += 1) {
    const job = Object.values(state.jobs).find((item) => item.state === 'queued' && item.nextAt <= now)
    if (!job) break
    const claimed = run(state, agent, { name: 'job_claim', operationId: `claim-${job.id}-${job.fence + 1}`.slice(0, 180), body: { jobId: job.id } }, now)
    const fence = (claimed.result as { fence: number }).fence
    state = claimed.state
    const current = state.cases[job.caseId]
    state = run(state, agent, {
      name: 'process_case', operationId: `process-${job.id}-${fence}`.slice(0, 180), expectedVersion: current.version, caseId: current.id, body: { jobId: job.id, fence },
    }, now).state
    state = run(state, agent, { name: 'job_finish', operationId: `finish-${job.id}-${fence}`.slice(0, 180), body: { jobId: job.id, fence } }, now).state
  }
  return state
}

function create(state: State, body: Record<string, unknown>, operationId: string) {
  return { state: flush(run(state, user, { name: 'create_case', operationId, expectedVersion: 0, body }).state) }
}

test('one utterance can reserve south hall water and refer the linked rescue', () => {
  let state = boot()
  state = run(state, user, { name: 'set_consent', operationId: 'consent-location-01', body: { type: 'precise_location', granted: true } }).state
  const location = { label: 'South Hall', source: 'landmark', lat: 32.7, lon: -96.8, accuracyM: 30, capturedAt: 1_700_000_000_000, confirmed: true }
  state = create(state, {
    id: 'maya-water-01', text: '4 water', originalText: 'water and a trapped neighbor', category: 'water', quantity: 4, danger: 'no',
    location, confirmed: true, affectedPerson: 'myself', accessibleKnown: true, conversationId: 'maya-conversation', shelterId: 'shelter-b',
  }, 'create-maya-water').state
  state = create(state, {
    id: 'maya-rescue-1', text: 'Person possibly trapped', originalText: 'water and a trapped neighbor', category: 'rescue', quantity: 1, danger: 'unsure',
    location, confirmed: true, affectedPerson: 'someone_else', accessibleKnown: true, conversationId: 'maya-conversation', shelterId: 'shelter-b',
  }, 'create-maya-rescue').state
  const water = state.cases['maya-water-01']
  const rescue = state.cases['maya-rescue-1']
  assert.equal(water.requestState, 'assigned')
  assert.equal(state.stock['water-south'].available, 2)
  assert.equal(state.stock['water-south'].reserved, 4)
  assert.equal(rescue.referralId.startsWith('ref-'), true)
  assert.equal(state.tasks[water.assignmentId].caseId, water.id)
  assert.equal(Object.values(state.tasks).some((task) => task.caseId === rescue.id), false)
  assert.match(state.events.map((event) => event.summary).join(' '), /Reserved 4 water/)
})

test('north hall water shortfall transfers from south and still balances', () => {
  let state = boot()
  state = create(state, {
    id: 'north-water-4', text: '4 water', category: 'water', quantity: 4, danger: 'no',
    location: { label: 'North Hall', source: 'landmark', capturedAt: 1, confirmed: true },
    confirmed: true, affectedPerson: 'myself', shelterId: 'shelter-a', conversationId: 'north-water-4',
  }, 'create-north-water').state
  const transfer = state.transfers['xfer-north-water-4']
  assert.equal(transfer.state, 'received')
  assert.equal(transfer.offered, transfer.held + transfer.inTransit + transfer.received + transfer.lost)
  assert.equal(state.stock['water-north'].available + state.stock['water-north'].reserved + state.stock['water-south'].available + state.stock['water-south'].reserved, 8)
  assert.equal(state.cases['north-water-4'].requestState, 'assigned')
})

test('charging without a spot stays open and does not reserve', () => {
  let state = boot()
  state = create(state, {
    id: 'charge-unknown', text: 'Need a charger', category: 'charging', quantity: 1, danger: 'no', accessibleKnown: false,
    location: { label: 'North Hall', source: 'manual', capturedAt: 1, confirmed: true },
    confirmed: true, affectedPerson: 'myself', conversationId: 'charge-unknown', shelterId: 'shelter-a',
  }, 'create-charge-unkn').state
  assert.equal(state.cases['charge-unknown'].state, 'needs_info')
  assert.equal(state.cases['charge-unknown'].assignmentId, '')
  assert.match(state.cases['charge-unknown'].missing.join(' '), /accessible/)
})

test('forty bottles is rejected and fourteen is kept', () => {
  let state = boot()
  assert.throws(() => create(state, {
    id: 'water-forty-1', text: '40 water', category: 'water', quantity: 40, danger: 'no',
    location: { label: 'South Hall', source: 'manual', capturedAt: 1, confirmed: true },
    confirmed: true, affectedPerson: 'myself', conversationId: 'water-forty-1', shelterId: 'shelter-b',
  }, 'create-water-forty'), /INVALID_INPUT/)
  state = create(state, {
    id: 'water-fourteen', text: '14 water', category: 'water', quantity: 14, danger: 'no',
    location: { label: 'South Hall', source: 'manual', capturedAt: 1, confirmed: true },
    confirmed: true, affectedPerson: 'myself', conversationId: 'water-fourteen', shelterId: 'shelter-b',
  }, 'create-water-14').state
  assert.equal(state.cases['water-fourteen'].quantity, 14)
})

test('two reservations of the last unit let exactly one succeed', () => {
  let state = boot()
  state.stock['water-south'].available = 1
  state.stock['water-north'].available = 0
  state = create(state, {
    id: 'last-unit-aaa', text: '1 water', category: 'water', quantity: 1, danger: 'no',
    location: { label: 'South Hall', source: 'manual', capturedAt: 1, confirmed: true },
    confirmed: true, affectedPerson: 'myself', conversationId: 'last-unit-aaa', shelterId: 'shelter-b',
  }, 'create-last-unit-a').state
  state = create(state, {
    id: 'last-unit-bbb', text: '1 water', category: 'water', quantity: 1, danger: 'no',
    location: { label: 'South Hall', source: 'manual', capturedAt: 1, confirmed: true },
    confirmed: true, affectedPerson: 'myself', conversationId: 'last-unit-bbb', shelterId: 'shelter-b',
  }, 'create-last-unit-b').state
  const assigned = ['last-unit-aaa', 'last-unit-bbb'].filter((id) => state.cases[id].requestState === 'assigned')
  assert.equal(assigned.length, 1)
  assert.equal(state.stock['water-south'].available, 0)
})

test('ending a call does not close the case', () => {
  let state = boot()
  state = create(state, {
    id: 'call-case-001', text: '1 water', category: 'water', quantity: 1, danger: 'no',
    location: { label: 'North Hall', source: 'manual', capturedAt: 1, confirmed: true },
    confirmed: true, affectedPerson: 'myself', conversationId: 'call-case-001', shelterId: 'shelter-a',
  }, 'create-call-case').state
  const version = state.cases['call-case-001'].version
  state = run(state, user, { name: 'start_call', operationId: 'start-call-0001', caseId: 'call-case-001', expectedVersion: version, body: { callId: 'call-id-000001', deviceId: 'phone-a' } }).state
  state = run(state, user, { name: 'end_call', operationId: 'end-call-000001', body: { callId: 'call-id-000001', deviceId: 'phone-a' } }).state
  assert.equal(state.calls['call-id-000001'].state, 'ended')
  assert.notEqual(state.cases['call-case-001'].state, 'resolved')
})

test('callback consent off schedules nothing', () => {
  let state = boot()
  state = create(state, {
    id: 'charge-nocall', text: 'Need a charger', category: 'charging', quantity: 1, danger: 'no', accessibleKnown: false,
    location: { label: 'North Hall', source: 'manual', capturedAt: 1, confirmed: true },
    confirmed: true, affectedPerson: 'myself', conversationId: 'charge-nocall', shelterId: 'shelter-a',
  }, 'create-charge-nocb').state
  assert.equal(Object.keys(state.callbacks).length, 0)
})

test('a fire report is not offered to a volunteer', () => {
  let state = boot()
  state = run(state, user, { name: 'set_consent', operationId: 'consent-fire-loc1', body: { type: 'precise_location', granted: true } }).state
  state = create(state, {
    id: 'fire-hallway1', text: 'Smoke in the hallway', category: 'fire', quantity: 1, danger: 'yes',
    location: { label: 'Hallway', source: 'gps', lat: 32.78, lon: -96.8, accuracyM: 20, capturedAt: 1_700_000_000_000, confirmed: true },
    confirmed: true, affectedPerson: 'someone_else', conversationId: 'fire-hallway1', shelterId: 'shelter-a',
  }, 'create-fire-hall').state
  assert.equal(state.cases['fire-hallway1'].priority, 'urgent_unverified')
  assert.equal(Object.values(state.tasks).length, 0)
  assert.match(state.events.map((event) => event.type).join(' '), /send_referral/)
})

test('agent cannot grant a role', () => {
  const state = boot()
  assert.throws(() => run(state, agent, { name: 'admin_grant', operationId: 'agent-grant-0001', body: { userId: user.id, role: 'admin' } }), /UNAUTHORIZED/)
})
