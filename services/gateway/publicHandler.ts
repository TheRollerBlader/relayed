import { randomBytes, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { authenticate, digest, outboxKey } from './auth.ts'
import { analyzeFrame, extractIntake } from './model.ts'
import { applyCommand, viewFor } from '../../shared/autonomy/engine.ts'
import { readSide, updateState, writeSide } from '../stateStore.ts'
import { safeError } from '../http.ts'
import type { Actor, Command, Service, State } from '../../shared/autonomy/contracts.ts'

const agent: Actor = { id: 'relayaid-agent', kind: 'agent' }
const guestHits: number[] = []
function guestAllowed() {
  const now = Date.now()
  while (guestHits.length && now - guestHits[0] > 60_000) guestHits.shift()
  if (guestHits.length >= 30) return false
  guestHits.push(now)
  return true
}
const allowed = new Set([
  'create_case',
  'set_consent',
  'update_case',
  'volunteer_action',
  'confirm_delivery',
  'dispute_delivery',
  'cancel_case',
  'claim_callback',
  'start_call',
  'answer_call',
  'end_call',
  'decline_call',
  'set_availability',
  'admin_grant',
  'admin_service',
  'admin_policy',
  'delete_account',
  'agency_status',
  'refresh_location',
])

function ensureSecrets() {
  if (!process.env['OUTBOX_MASTER_KEY']) {
    if (process.env['AWS_LAMBDA_FUNCTION_NAME'] || process.env['NETLIFY']) throw new Error('UNAUTHORIZED')
    process.env.OUTBOX_MASTER_KEY = 'dev-outbox-master-key-not-for-production'
  }
}

function reply(status: number, value: unknown) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

function step(state: State, actor: Actor, command: Command, now = Date.now()): State {
  return applyCommand(state, actor, command, now).state
}

function tryStep(state: State, actor: Actor, command: Command, now = Date.now()): State {
  try {
    return step(state, actor, command, now)
  } catch {
    return state
  }
}

function runJobs(state: State, now: number): State {
  let current = state
  for (let index = 0; index < 6; index += 1) {
    const job = Object.values(current.jobs).find((item) => item.state === 'queued' && item.nextAt <= now)
    if (!job) break
    const claimId = `claim-${job.id}-${job.fence + 1}`.slice(0, 180)
    let claimed: { state: State; result: unknown }
    try {
      claimed = applyCommand(current, agent, { name: 'job_claim', operationId: claimId, body: { jobId: job.id } }, now)
    } catch {
      break
    }
    const fence = (claimed.result as { fence?: number } | undefined)?.fence
    if (!fence) break
    current = claimed.state
    current = tryStep(
      current,
      agent,
      {
        name: 'process_case',
        operationId: `process-${job.id}-${fence}`.slice(0, 180),
        expectedVersion: job.caseVersion,
        caseId: job.caseId,
        body: { jobId: job.id, fence },
      },
      now,
    )
    current = tryStep(
      current,
      agent,
      { name: 'job_finish', operationId: `finish-${job.id}-${fence}`.slice(0, 180), body: { jobId: job.id, fence } },
      now,
    )
  }
  return current
}

function nextReferral(service: Service, state: string) {
  if (service.mode === 'no_ack') return null
  if (state === 'sent') return 'acked'
  if (state === 'acked') {
    if (!service.autoAccept) return null
    if (service.mode === 'busy') return 'busy'
    if (service.mode === 'reject') return 'declined'
    return 'accepted'
  }
  const flow: Record<string, string> = { accepted: 'dispatched', dispatched: 'en_route', en_route: 'arrived', arrived: 'resolved' }
  return flow[state] || null
}

/** One sandbox step per call so the timeline can show each state on its own. */
function advanceReferrals(state: State, now: number): State {
  let current = state
  for (const referral of Object.values({ ...current.referrals })) {
    const service = current.services[referral.serviceId]
    const latest = current.referrals[referral.id]
    if (!service || !latest || latest.retired) continue
    if (latest.state !== 'queued' && latest.nextAt > now) continue
    if (latest.state === 'queued' || (service.mode === 'no_ack' && latest.attempts < 3)) {
      current = tryStep(
        current,
        { id: 'gateway', kind: 'gateway' },
        { name: 'referral_sent', operationId: `send-${latest.id}-${latest.attempts + 1}`, body: { referralId: latest.id } },
        now,
      )
      continue
    }
    const outcome = nextReferral(service, latest.state)
    if (!outcome) continue
    const seq = latest.seq + 1
    current = tryStep(
      current,
      { id: service.orgId, kind: 'sandbox' },
      {
        name: 'referral_event',
        operationId: `syn-${latest.id}-${seq}-${outcome}`.slice(0, 180),
        body: { referralId: latest.id, seq, state: outcome },
      },
      now,
    )
    if (service.mode === 'duplicate') {
      current = tryStep(
        current,
        { id: service.orgId, kind: 'sandbox' },
        {
          name: 'referral_event',
          operationId: `syn-${latest.id}-${seq}-${outcome}-dup`.slice(0, 180),
          body: { referralId: latest.id, seq, state: outcome },
        },
        now,
      )
    }
  }
  const escalate = Object.values(current.referrals).some((item) => current.services[item.serviceId]?.mode === 'no_ack' && !item.retired && item.attempts >= 3)
  return tryStep(current, agent, { name: 'tick', operationId: `tick-${now}`, body: {} }, escalate ? now + 31_000 : now)
}

function settle(state: State): State {
  const now = Date.now()
  return advanceReferrals(runJobs(state, now), now)
}

async function notify(ownerId: string, body: string) {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return
  const raw = await readSide('push-subs')
  const subs = raw ? (JSON.parse(raw) as { ownerId: string; subscription: object }[]) : []
  const webpush = createRequire(import.meta.url)('web-push') as {
    setVapidDetails: (subject: string, publicKey: string, privateKey: string) => void
    sendNotification: (subscription: object, payload: string) => Promise<unknown>
  }
  webpush.setVapidDetails('mailto:desk@relayaid.us', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY)
  await Promise.all(
    subs
      .filter((item) => item.ownerId === ownerId)
      .map((item) =>
        webpush
          .sendNotification(item.subscription as never, JSON.stringify({ title: 'RelayAid', body, url: '/' }))
          .catch(() => undefined),
      ),
  )
}

export async function handlePublicRequest(req: Request): Promise<Response> {
  const url = new URL(req.url)
  if (!url.pathname.startsWith('/api/')) return reply(404, { error: 'NOT_FOUND' })
  try {
    ensureSecrets()
    if (url.pathname === '/api/push/key' && req.method === 'GET') {
      return reply(200, process.env.VAPID_PUBLIC_KEY ? { enabled: true, publicKey: process.env.VAPID_PUBLIC_KEY } : { enabled: false })
    }
    if (url.pathname === '/api/guest' && req.method === 'POST') {
      if (!guestAllowed()) return reply(429, { error: 'RATE_LIMITED' })
      const id = randomBytes(32).toString('hex')
      const secret = randomBytes(32).toString('base64url')
      const actor: Actor = { id, kind: 'user', verified: false }
      await updateState((state) =>
        settle(
          step(state, actor, {
            name: 'register',
            operationId: randomUUID(),
            expectedVersion: 0,
            body: { label: 'Guest', capabilityHash: digest(secret) },
          }),
        ),
      )
      return reply(201, { capability: `guest.${id}.${secret}`, expiresAt: Date.now() + 86_400_000 })
    }

    const peeked = await updateState(async (state) => settle(state))
    const actor = await authenticate({ headers: { authorization: req.headers.get('authorization') || undefined, 'x-guest-capability': req.headers.get('x-guest-capability') || undefined } } as never, peeked)
    if (!peeked.profiles[actor.id]) {
      await updateState((state) =>
        step(state, actor, { name: 'register', operationId: randomUUID(), expectedVersion: 0, body: { label: 'Resident' } }),
      )
    }
    const state = await updateState(async (current) => current)

    if (url.pathname === '/api/session' || url.pathname === '/api/state' || url.pathname === '/api/export') {
      return reply(200, viewFor(state, actor))
    }
    if (url.pathname === '/api/outbox-key') return reply(200, { ownerIdentity: actor.id, key: outboxKey(actor.id) })
    if (url.pathname === '/api/photo' && req.method === 'GET') {
      const caseId = url.searchParams.get('caseId') || ''
      const row = state.cases[caseId]
      if (!row || row.ownerId !== actor.id) return reply(404, { error: 'NOT_FOUND' })
      const image = await readSide(`photo-${caseId}`)
      return reply(200, { image: image || '' })
    }
    if (url.pathname === '/api/photo' && req.method === 'POST') {
      const input = (await req.json()) as { caseId?: string; image?: string }
      const row = state.cases[input.caseId || '']
      if (!row || row.ownerId !== actor.id) return reply(404, { error: 'NOT_FOUND' })
      if (!input.image || !/^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(input.image) || input.image.length > 900_000) {
        return reply(400, { error: 'INVALID_INPUT' })
      }
      await writeSide(`photo-${input.caseId}`, input.image)
      return reply(200, { ok: true })
    }
    if (url.pathname === '/api/push/subscribe' && req.method === 'POST') {
      const subscription = await req.json()
      const raw = await readSide('push-subs')
      const subs = raw ? (JSON.parse(raw) as { ownerId: string; subscription: object }[]) : []
      subs.push({ ownerId: actor.id, subscription })
      await writeSide('push-subs', JSON.stringify(subs.slice(-40)))
      return reply(200, { ok: true })
    }
    if (url.pathname === '/api/guest/upgrade' && req.method === 'POST') {
      if (!actor.verified) return reply(401, { error: 'UNAUTHORIZED' })
      const guest = await authenticate(
        { headers: { authorization: `Bearer ${req.headers.get('x-guest-capability') || ''}` } } as never,
        state,
      )
      const next = await updateState((current) =>
        settle(
          step(current, { id: 'gateway', kind: 'gateway' }, {
            name: 'upgrade_guest',
            operationId: randomUUID(),
            body: { oldId: guest.id, newId: actor.id, verified: true },
          }),
        ),
      )
      return reply(200, viewFor(next, actor))
    }
    if (url.pathname === '/api/intake/confirm' && req.method === 'POST') {
      const input = (await req.json()) as {
        conversationId?: string
        text?: string
        shelterId?: string
        affectedPerson?: string
        location?: unknown
        callbacks?: boolean
        shareLocation?: boolean
        replaceId?: string
        drafts?: { category?: string; quantity?: number; danger?: string; summary?: string; accessibleKnown?: boolean; accessible?: boolean }[]
      }
      if (!input.conversationId || !/^[a-zA-Z0-9_-]{8,80}$/.test(input.conversationId) || !Array.isArray(input.drafts) || input.drafts.length < 1 || input.drafts.length > 5) {
        return reply(400, { error: 'INVALID_INPUT' })
      }
      const next = await updateState((current) => {
        let updated = current
        if (input.callbacks === true) {
          updated = step(updated, actor, { name: 'set_consent', operationId: `consent-cb-${input.conversationId}`, body: { type: 'callbacks', granted: true } })
        }
        if (input.shareLocation === true) {
          updated = step(updated, actor, { name: 'set_consent', operationId: `consent-loc-${input.conversationId}`, body: { type: 'precise_location', granted: true } })
        }
        const drafts = input.drafts || []
        let start = 0
        if (input.replaceId && updated.cases[input.replaceId]?.ownerId === actor.id) {
          const first = drafts[0]
          updated = step(updated, actor, {
            name: 'update_case',
            operationId: `replace-${input.conversationId}`,
            caseId: input.replaceId,
            expectedVersion: updated.cases[input.replaceId].version,
            body: {
              text: String(first?.summary || input.text || 'Report').slice(0, 2000),
              originalText: String(input.text || first?.summary || 'Report').slice(0, 2000),
              category: first?.category,
              quantity: first?.quantity,
              danger: first?.danger,
              location: input.location ?? null,
              confirmed: true,
              accessible: first?.accessible === true,
              accessibleKnown: first?.accessibleKnown === true,
            },
          })
          start = 1
        }
        for (let index = start; index < drafts.length; index += 1) {
          const draft = drafts[index]
          updated = step(updated, actor, {
            name: 'create_case',
            operationId: `confirm-${input.conversationId}-${index + 1}`,
            expectedVersion: 0,
            body: {
              id: `${input.conversationId}-${index + 1}`,
              text: String(draft?.summary || input.text || 'Report').slice(0, 2000),
              originalText: String(input.text || draft?.summary || 'Report').slice(0, 2000),
              category: draft?.category,
              quantity: draft?.quantity,
              danger: draft?.danger || 'no',
              location: input.location ?? null,
              confirmed: true,
              affectedPerson: String(input.affectedPerson || 'myself').slice(0, 150),
              accessible: draft?.accessible === true,
              accessibleKnown: draft?.accessibleKnown === true,
              conversationId: input.conversationId,
              shelterId: input.shelterId === 'shelter-b' ? 'shelter-b' : 'shelter-a',
            },
          })
        }
        return settle(updated)
      })
      return reply(200, { view: viewFor(next, actor) })
    }
    if (url.pathname === '/api/intake/analyze' && req.method === 'POST') {
      const input = (await req.json()) as { text?: string; language?: string }
      if (typeof input.text !== 'string' || input.text.length > 2000) return reply(400, { error: 'INVALID_INPUT' })
      return reply(200, await extractIntake(input.text, input.language === 'es' ? 'es' : 'en'))
    }
    if (url.pathname === '/api/command' && req.method === 'POST') {
      const input = (await req.json()) as Command
      if (!allowed.has(input.name)) return reply(400, { error: 'UNKNOWN_COMMAND' })
      const next = await updateState((current) => settle(step(current, actor, input)))
      const view = viewFor(next, actor)
      if (view.messages.length) await notify(actor.id, view.messages[view.messages.length - 1]?.text || 'A follow-up about your case')
      return reply(200, { result: next.receipts[`${actor.kind}:${actor.id}:${input.operationId}`]?.result, view })
    }
    if (url.pathname === '/api/talk' && req.method === 'POST') {
      const input = (await req.json()) as { callId?: string; text?: string }
      const call = state.calls[input.callId || '']
      if (!call || call.ownerId !== actor.id || !input.text || input.text.length > 2000) return reply(400, { error: 'INVALID_INPUT' })
      const heard = await extractIntake(input.text, 'en')
      const spot = /\baccessible\b/i.test(input.text) ? true : /\bstandard\b/i.test(input.text) ? false : null
      const row = state.cases[call.caseId]
      const answeringSpot = Boolean(row && row.category === 'charging' && row.chargerKnown !== true && spot !== null)
      const readback = answeringSpot
        ? `AI unavailable. I recorded ${spot ? 'an accessible' : 'a standard'} charging spot. This is not an arrival time, and nobody has been dispatched.`
        : heard.drafts.length
          ? `${heard.live ? 'NVIDIA interpretation — review before confirming.' : 'AI unavailable. Deterministic readback only.'} I heard: ${heard.drafts.map((item) => item.summary).join('; ')}. Confirm the place and quantity. This is not an arrival time, and nobody has been dispatched.`
          : 'AI unavailable. Your words stay on this case. This is a text conversation, not a voice agent, and it does not dispatch anyone.'
      const next = await updateState((current) => {
        let updated = tryStep(current, agent, {
          name: 'transcript',
          operationId: randomUUID(),
          body: { callId: call.id, role: 'user', text: input.text },
        })
        const live = updated.cases[call.caseId]
        if (answeringSpot && live) {
          updated = tryStep(updated, actor, {
            name: 'update_case',
            operationId: randomUUID(),
            caseId: live.id,
            expectedVersion: live.version,
            body: { accessible: spot, accessibleKnown: true, confirmed: true },
          })
        }
        updated = tryStep(updated, agent, {
          name: 'transcript',
          operationId: randomUUID(),
          body: { callId: call.id, role: 'assistant', text: readback },
        })
        return settle(updated)
      })
      return reply(200, { view: viewFor(next, actor), live: heard.live, caption: readback })
    }
    if (url.pathname === '/api/media/token' && req.method === 'POST') {
      const input = (await req.json()) as { callId?: string; deviceId?: string }
      const call = state.calls[input.callId || '']
      if (!call || call.ownerId !== actor.id || call.deviceId !== input.deviceId) return reply(401, { error: 'UNAUTHORIZED' })
      if (!process.env.LIVEKIT_URL || !process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET) {
        return reply(200, { mode: 'text', recording: false, speechLanguages: [] })
      }
      return reply(200, { mode: 'text', recording: false, speechLanguages: [], note: 'Voice transport is not enabled for this site.' })
    }
    if (url.pathname === '/api/media/frame' && req.method === 'POST') {
      if (!process.env.NVIDIA_API_KEY) return reply(200, { live: false, observation: 'Camera analysis is not configured. Describe the scene in text.' })
      const input = (await req.json()) as { callId?: string; image?: string }
      const call = state.calls[input.callId || '']
      if (!call || call.ownerId !== actor.id) return reply(401, { error: 'UNAUTHORIZED' })
      const controller = new AbortController()
      const result = await analyzeFrame(String(input.image || ''), controller.signal)
      return reply(200, result)
    }
    if (url.pathname === '/api/logout' && req.method === 'POST') {
      const next = await updateState((current) => {
        let updated = current
        for (const call of Object.values(current.calls).filter((item) => item.ownerId === actor.id && !['ended', 'failed'].includes(item.state))) {
          updated = tryStep(updated, actor, {
            name: 'end_call',
            operationId: randomUUID(),
            body: { callId: call.id, deviceId: call.deviceId },
          })
        }
        return updated
      })
      return reply(200, { ok: true, view: viewFor(next, actor) })
    }
    return reply(404, { error: 'NOT_FOUND' })
  } catch (error) {
    const code = safeError(error)
    return reply(code === 'UNAUTHORIZED' ? 401 : 400, { error: code })
  }
}
