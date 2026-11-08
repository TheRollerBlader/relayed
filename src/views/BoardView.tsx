import { useEffect, useState } from 'react'
import { HallMap } from '../components/HallMap'
import { primaryButton } from '../components/Dialog'
import { ErrorBanner } from '../components/ErrorBanner'
import { StatusBadge } from '../components/StatusBadge'
import { taskBadge, timestampMs } from '../lib/copy'
import { tables } from '../module_bindings/index.ts'
import { runReducer, useConnection } from '../lib/server'
import { useRows } from '../lib/tables'

const COLUMNS = [
  { id: 'unassigned', title: 'Unassigned', states: ['unassigned', 'declined', 'cant_do'] },
  { id: 'offered', title: 'Offered', states: ['offered'] },
  { id: 'accepted', title: 'Accepted', states: ['accepted'] },
  { id: 'progress', title: 'In progress', states: ['in_progress'] },
  { id: 'delivered', title: 'Delivered', states: ['delivered'] },
  { id: 'review', title: 'Needs review', states: ['overdue_review'] },
] as const

export function BoardView() {
  const connection = useConnection()
  const [rows] = useRows(tables.coordinatorBoard)
  const [volunteers] = useRows(tables.coordinatorVolunteers)
  const [events] = useRows(tables.recentEvents)
  const [locations] = useRows(tables.coordinatorLocations)
  const [followUps] = useRows(tables.coordinatorFollowUps)
  const [choice, setChoice] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState('')
  const [now, setNow] = useState(0)
  useEffect(() => {
    const update = () => setNow(Date.now())
    update()
    const timer = window.setInterval(update, 15_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!connection) return
    for (const row of rows) {
      const due = timestampMs(row.dueAt)
      if (!due || due > Date.now()) continue
      if (!['accepted', 'in_progress', 'offered'].includes(row.dispatchState)) continue
      void runReducer(connection, (current) =>
        current.reducers.flagOverdue({ assignmentId: row.assignmentId, actionId: crypto.randomUUID() }),
      )
    }
    for (const item of followUps) {
      const due = timestampMs(item.deadline)
      if (!due || due > Date.now() || item.state === 'overdue_review') continue
      void runReducer(connection, (current) =>
        current.reducers.flagFollowUp({ followUpId: item.followUpId, actionId: crypto.randomUUID() }),
      )
    }
  }, [connection, rows, followUps])

  async function offer(assignmentId: bigint, volunteerIdentity: (typeof volunteers)[number]['identity']) {
    setPending(assignmentId.toString())
    setError(null)
    const result = await runReducer(connection, (current) =>
      current.reducers.offerTask({
        assignmentId,
        volunteerIdentity,
        dueAtMicros: BigInt(Date.now() + 60 * 60 * 1000) * 1000n,
        actionId: crypto.randomUUID(),
      }),
    )
    setPending('')
    if (!result.ok) setError(result.text)
  }

  async function release(assignmentId: bigint) {
    setPending(assignmentId.toString())
    setError(null)
    const result = await runReducer(connection, (current) =>
      current.reducers.releaseAssignment({ assignmentId, reasonCode: 'plan_changed' }),
    )
    setPending('')
    if (!result.ok) setError(result.text)
  }

  const overdueFollowUps = followUps.filter((item) => item.state === 'open' || item.state === 'overdue_review')

  return (
    <div>
      <p className="font-mono text-[11px] tracking-[0.18em] text-accent">COORDINATOR</p>
      <h1 className="mt-3 text-4xl font-medium tracking-tight">Assignment board</h1>
      <p className="mt-3 max-w-2xl text-muted">
        An offer changes who holds the task. The reserved capacity stays put until you release it.
      </p>
      {overdueFollowUps.length > 0 && (
        <p className="mt-4 border border-line bg-panel px-4 py-3 text-sm" role="status">
          {overdueFollowUps.length} follow-up{overdueFollowUps.length === 1 ? '' : 's'} still open, including any past a staff deadline. Nothing is assumed abandoned.
        </p>
      )}
      <div className="mt-6">
        <HallMap
          points={locations
            .filter((point) => point.sharing && point.source === 'gps')
            .map((point) => {
              const seen = timestampMs(point.receivedAt)
              const stale = seen !== null && now - seen > 2 * 60 * 1000
              return {
                key: point.subjectKey,
                lat: point.lat,
                lon: point.lon,
                accuracyM: point.accuracyM,
                label: stale ? 'Stale' : `± ${Math.round(point.accuracyM)} m`,
              }
            })}
        />
        {locations.some((point) => {
          const seen = timestampMs(point.receivedAt)
          return point.sharing && seen !== null && now - seen > 2 * 60 * 1000
        }) && <p className="mt-2 text-sm">Stale: last location is more than 2 minutes old.</p>}
      </div>
      {error && (
        <div className="mt-4">
          <ErrorBanner title="Not saved" text={error} />
        </div>
      )}
      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        {COLUMNS.map((column) => (
          <section key={column.id} className="border border-line bg-panel p-4">
            <h2 className="font-mono text-[11px] tracking-[0.16em] text-faint">{column.title}</h2>
            <ul className="mt-3 space-y-3">
              {rows.filter((row) => (column.states as readonly string[]).includes(row.dispatchState)).map((row) => {
                const suggested = volunteers.filter((person) => person.available && (row.kind === 'water' ? person.canCarryWater : person.chargerEscort))
                const selected = choice[row.assignmentId.toString()] ?? suggested[0]?.identity.toHexString() ?? ''
                const volunteer = suggested.find((person) => person.identity.toHexString() === selected)
                const trail = events.filter(
                  (event) => event.subjectId === row.assignmentId.toString() && (event.type.startsWith('task_') || event.type === 'volunteer_assigned'),
                )
                return (
                  <li key={row.assignmentId.toString()} className="border border-line p-3">
                    <div className="flex items-start justify-between gap-3">
                      <p className="font-medium">{row.residentLabel}</p>
                      <StatusBadge status={taskBadge(row.dispatchState, row.state)} />
                    </div>
                    <p className="mt-1 text-sm text-muted">
                      {row.units} {row.kind}
                      {row.accessible ? ' · accessible' : ''}
                      {row.volunteerLabel ? ` · ${row.volunteerLabel}` : ''}
                    </p>
                    {row.declineReason && <p className="mt-2 text-sm">Reason: {row.declineReason}</p>}
                    {column.id === 'unassigned' && suggested.length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-2">
                        <select
                          value={selected}
                          onChange={(event) => setChoice({ ...choice, [row.assignmentId.toString()]: event.target.value })}
                          className="min-h-12 border border-line bg-canvas px-3 text-sm"
                        >
                          {suggested.map((person) => (
                            <option key={person.identity.toHexString()} value={person.identity.toHexString()}>
                              {person.label} · {person.openTasks} open{person.zone ? ` · ${person.zone}` : ''}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          disabled={!connection || !volunteer || pending !== ''}
                          onClick={() => volunteer && void offer(row.assignmentId, volunteer.identity)}
                          className={primaryButton}
                        >
                          Offer
                        </button>
                      </div>
                    )}
                    {row.state === 'reserved' && (
                      <button type="button" disabled={!connection || pending !== ''} onClick={() => void release(row.assignmentId)} className="mt-3 text-sm text-muted">
                        Release capacity
                      </button>
                    )}
                    {trail.length > 0 && (
                      <ul className="mt-3 space-y-1 text-xs text-faint">
                        {trail.slice(0, 4).map((event) => (
                          <li key={event.eventId.toString()}>{event.type.replaceAll('_', ' ')}{event.details ? ` · ${event.details}` : ''}</li>
                        ))}
                      </ul>
                    )}
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  )
}
