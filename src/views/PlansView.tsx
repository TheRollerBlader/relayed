import { useState } from 'react'
import { Link } from 'react-router-dom'
import { primaryButton } from '../components/Dialog'
import { ErrorBanner } from '../components/ErrorBanner'
import { spacetimeEnabled } from '../lib/config'
import { useSession } from '../lib/session'
import { tables } from '../module_bindings/index.ts'
import { runReducer, useConnection } from '../lib/server'
import { useRows } from '../lib/tables'
import { difference, groupPlans, latestPair } from './planGroups'

const POLICIES = ['most_requests', 'most_quantity', 'longest_wait', 'accessible_coverage'] as const

export function PlansView() {
  const session = useSession()
  const connection = useConnection()
  const [rows] = useRows(tables.coordinatorPlanDetails)
  const [runs] = useRows(tables.coordinatorModelRuns)
  const [jobs] = useRows(tables.coordinatorAiJobs)
  const [jobEvents] = useRows(tables.coordinatorAiEvents)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [localRun, setLocalRun] = useState<{ live: boolean; explanation: string; trace: string[] } | null>(null)
  const groups = groupPlans(rows)
  const pair = latestPair(groups)
  const hypothetical = groups.filter((group) => group.head.hypothetical)
  const latestRun = [...runs].sort((a, b) => Number(b.endedAt.microsSinceUnixEpoch - a.endedAt.microsSinceUnixEpoch))[0]
  const latestJob = [...jobs].sort((a, b) => Number(b.updatedAt.microsSinceUnixEpoch - a.updatedAt.microsSinceUnixEpoch))[0]
  const jobTrace = latestJob ? jobEvents.filter((item) => item.jobId === latestJob.jobId).sort((a, b) => a.seq - b.seq) : []

  async function generate(strategy: 'fcfs' | 'suitability', whatIf: { kind: string; accessible: boolean; count: number }[], policy: string) {
    setPending(true)
    setError(null)
    const result = await runReducer(connection, (current) =>
      current.reducers.generatePlan({
        shelterId: session.shelterId,
        strategy,
        whatIf,
        policy,
      }),
    )
    setPending(false)
    if (!result.ok) setError(result.text)
  }

  return (
    <div>
      <p className="font-mono text-[11px] tracking-[0.18em] text-accent">COORDINATOR</p>
      <h1 className="mt-3 text-4xl font-medium tracking-tight">Plans</h1>
      <p className="mt-3 max-w-2xl text-muted">{difference(pair.fcfs, pair.suitability)}</p>
      <div className="mt-6 flex flex-wrap gap-3">
        <button
          type="button"
          disabled={!connection || pending}
          onClick={() => {
            void (async () => {
              setPending(true)
              setError(null)
              const first = await runReducer(connection, (current) =>
                current.reducers.generatePlan({ shelterId: session.shelterId, strategy: 'fcfs', whatIf: [], policy: 'most_requests' }),
              )
              if (!first.ok) {
                setPending(false)
                setError(first.text)
                return
              }
              const second = await runReducer(connection, (current) =>
                current.reducers.generatePlan({ shelterId: session.shelterId, strategy: 'suitability', whatIf: [], policy: 'most_requests' }),
              )
              setPending(false)
              if (!second.ok) setError(second.text)
            })()
          }}
          className={primaryButton}
        >
          {pending ? 'Generating…' : 'Compare first-come and suitability'}
        </button>
        <button type="button" disabled={!connection || pending} onClick={() => void generate('fcfs', [], 'most_requests')} className="inline-flex min-h-12 items-center border border-line px-4 text-sm">
          {pending ? 'Generating…' : 'Generate first-come'}
        </button>
        <button type="button" disabled={!connection || pending} onClick={() => void generate('suitability', [], 'most_requests')} className="inline-flex min-h-12 items-center border border-line px-4 text-sm">
          {pending ? 'Generating…' : 'Generate suitability'}
        </button>
        {POLICIES.map((policy) => (
          <button key={policy} type="button" disabled={!connection || pending} onClick={() => void generate('suitability', [], policy)} className="inline-flex min-h-12 items-center border border-line px-4 text-sm">
            {policy.replaceAll('_', ' ')}
          </button>
        ))}
        <button type="button" disabled={!connection || pending} onClick={() => void generate('suitability', [{ kind: 'charger_slot', accessible: true, count: 1 }], 'most_requests')} className="inline-flex min-h-12 items-center border border-line px-4 text-sm">
          Add one charger
        </button>
        <button type="button" disabled={!connection || pending} onClick={() => void generate('suitability', [{ kind: 'water_stock', accessible: false, count: 2 }], 'most_requests')} className="inline-flex min-h-12 items-center border border-line px-4 text-sm">
          Transfer 2 water
        </button>
      </div>
      {error && (
        <div className="mt-4">
          <ErrorBanner title="Not generated" text={error} />
        </div>
      )}
      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <PlanColumn title="First-come-first-served" group={pair.fcfs} />
        <PlanColumn title="Suitability-aware" group={pair.suitability} />
      </div>
      <section className="mt-8">
        <h2 className="font-mono text-[11px] tracking-[0.16em] text-faint">POLICY COMPARISON</h2>
        <div className="mt-3 grid gap-4 lg:grid-cols-2">
          {POLICIES.map((policy) => (
            <PlanColumn
              key={policy}
              title={policy.replaceAll('_', ' ')}
              group={groups.find((group) => !group.head.hypothetical && group.head.strategy === 'suitability' && group.head.policy === policy)}
            />
          ))}
        </div>
      </section>
      <aside className="mt-8 border border-line bg-panel p-4">
        <h2 className="font-mono text-[11px] tracking-[0.16em] text-faint">ASSISTANT</h2>
        <p className="mt-3 text-sm">
          {assistantText(localRun, latestJob, latestRun)}
        </p>
        {latestJob?.rejectReason && (
          <p className="mt-2 text-sm">The assistant's proposal didn't match the solver results and was discarded.</p>
        )}
        {localRun && localRun.trace.length > 0 && (
          <ol className="mt-3 space-y-1 text-sm text-muted">
            {localRun.trace.map((line, index) => (
              <li key={`${line}-${index}`}>{index + 1}. {line} {localRun.live ? 'live' : 'non-AI'}</li>
            ))}
          </ol>
        )}
        {jobTrace.length > 0 && (
          <ol className="mt-3 space-y-1 text-sm text-muted">
            {jobTrace.map((item) => (
              <li key={item.eventId.toString()}>
                {item.seq}. {item.toolName} {item.resultRef} {item.live ? 'live' : 'non-AI'}
              </li>
            ))}
          </ol>
        )}
        {!latestJob && latestRun?.toolCalls.startsWith('[') && (
          <ul className="mt-3 space-y-1 text-sm text-muted">
            {traceLines(latestRun.toolCalls).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            if (!spacetimeEnabled || !connection) {
              setPending(true)
              setError(null)
              void fetch('/api/investigate', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ shelterId: session.shelterId }),
              })
                .then(async (response) => response.json() as Promise<{ nemotron?: boolean; outcome?: string; explanation?: string; trace?: string[] }>)
                .then((body) => {
                  setLocalRun({
                    live: body.nemotron === true && body.outcome === 'proposal',
                    explanation: body.explanation || 'Model unavailable; deterministic plan only.',
                    trace: body.trace ?? [],
                  })
                })
                .catch(() => setError('The assistant did not answer.'))
                .finally(() => setPending(false))
              return
            }
            void runReducer(connection, (current) =>
              current.reducers.requestAiJob({ shelterId: session.shelterId, jobClientId: crypto.randomUUID() }),
            ).then((result) => {
              if (!result.ok) setError(result.text)
            })
          }}
          className={`${primaryButton} mt-4`}
        >
          {pending ? 'Investigating…' : 'Investigate'}
        </button>
      </aside>
      {hypothetical.length > 0 && (
        <section className="mt-8">
          <h2 className="font-mono text-[11px] tracking-[0.16em] text-faint">HYPOTHETICAL</h2>
          <ul className="mt-3 grid gap-3">
            {hypothetical.map((group) => (
              <li key={group.head.planId.toString()} className="border border-line p-4">
                <p className="text-sm">Estimated only. Hypothetical: not real stock. Nothing was changed, and this cannot be approved.</p>
                <p className="mt-2 text-sm text-muted">{group.head.summary}</p>
                <Link to={`/c/plans/${group.head.planId.toString()}`} className="mt-3 inline-flex min-h-12 items-center text-accent">
                  View
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

const FALLBACK = 'Assistant unavailable: showing deterministic plans only (no AI).'

function assistantText(
  localRun: { live: boolean; explanation: string } | null,
  latestJob: { live?: boolean; state?: string; explanation?: string } | undefined,
  latestRun: { outcome?: string; explanation?: string } | undefined,
): string {
  if (localRun) return localRun.live ? localRun.explanation : FALLBACK
  if (latestJob) {
    if (!latestJob.live || latestJob.state === 'fallback') return FALLBACK
    return latestJob.explanation || 'Waiting for the assistant.'
  }
  if (latestRun) return latestRun.outcome === 'proposal' ? latestRun.explanation || '' : FALLBACK
  return FALLBACK
}

function traceLines(toolCalls: string): string[] {
  try {
    const parsed = JSON.parse(toolCalls) as { id?: string; tool?: string; result?: unknown }[]
    return parsed.map((item) => `${item.tool ?? 'tool'} ${item.id ?? ''} ${JSON.stringify(item.result)}`)
  } catch {
    return []
  }
}

function PlanColumn({ title, group }: { title: string; group: ReturnType<typeof latestPair>['fcfs'] }) {
  if (!group) return <article className="border border-line bg-panel p-4 text-sm text-muted">{title} is not generated yet.</article>
  const stale = group.head.inputSnapshotVersion !== group.head.liveSnapshotVersion
  return (
    <article className="border border-line bg-panel p-4">
      <h2 className="text-lg font-medium">{title}</h2>
      <p className="mt-2 text-sm text-muted">{group.head.summary}</p>
      <p className="mt-2 text-sm">Method: {group.head.method}. Policy: {group.head.policy.replaceAll('_', ' ')}. No policy here is called fair.</p>
      {stale && <p className="mt-3 text-sm">Out of date: things changed since this plan was made. Regenerate.</p>}
      <Link to={`/c/plans/${group.head.planId.toString()}`} className="mt-4 inline-flex min-h-12 items-center text-accent">
        Open plan
      </Link>
    </article>
  )
}
