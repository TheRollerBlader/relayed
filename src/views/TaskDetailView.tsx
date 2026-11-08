import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { primaryButton, quietButton } from '../components/Dialog'
import { ErrorBanner } from '../components/ErrorBanner'
import { resourceWords } from '../lib/copy'
import { registerLocationStop } from '../lib/liveLocation'
import { tables } from '../module_bindings/index.ts'
import { runReducer, useConnection } from '../lib/server'
import { useRows } from '../lib/tables'

export function TaskDetailView() {
  const { assignmentId = '' } = useParams()
  const connection = useConnection()
  const [rows] = useRows(tables.myAssignments)
  const [transfers] = useRows(tables.myTransfers)
  const row = rows.find((item) => item.assignmentId.toString() === assignmentId)
  const [pending, setPending] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [sharing, setSharing] = useState(false)
  const [locationNote, setLocationNote] = useState('')
  const watchId = useRef<number | null>(null)
  const seq = useRef(0n)
  const connectionRef = useRef(connection)
  const assignmentRef = useRef<bigint | null>(row?.assignmentId ?? null)
  useEffect(() => {
    connectionRef.current = connection
    assignmentRef.current = row?.assignmentId ?? null
  }, [connection, row?.assignmentId])

  function clearWatch() {
    if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current)
    watchId.current = null
    setSharing(false)
  }

  useEffect(() => {
    return registerLocationStop(() => {
      clearWatch()
      const current = connectionRef.current
      const assignment = assignmentRef.current
      if (!current || assignment === null) return
      void runReducer(current, (live) => live.reducers.stopTaskLocation({ assignmentId: assignment, transferId: 0n }))
    })
  }, [])

  useEffect(() => {
    return () => {
      if (watchId.current !== null) {
        navigator.geolocation.clearWatch(watchId.current)
        watchId.current = null
        const current = connectionRef.current
        const assignment = assignmentRef.current
        if (current && assignment !== null) {
          void runReducer(current, (live) => live.reducers.stopTaskLocation({ assignmentId: assignment, transferId: 0n }))
        }
      }
    }
  }, [])

  async function call(id: string, action: (current: NonNullable<typeof connection>) => Promise<void>) {
    if (!connection) return
    setPending(id)
    setError(null)
    const result = await runReducer(connection, action)
    setPending('')
    if (!result.ok) setError(result.text)
  }

  if (!row) {
    return (
      <div className="max-w-xl">
        <p className="text-muted">That task is not assigned to you.</p>
        {transfers.length > 0 && (
          <ul className="mt-6 space-y-3">
            {transfers.map((item) => (
              <li key={item.transferId.toString()} className="border border-line p-4">
                <p>Pickup {item.quantityOffered} water for {item.destName}</p>
                <p className="mt-1 text-sm text-muted">{item.volunteerState}</p>
                {item.volunteerState === 'offered' && (
                  <div className="mt-3 flex gap-2">
                    <button type="button" className={primaryButton} onClick={() => void call('accept-transfer', (current) => current.reducers.respondTransferTask({ transferId: item.transferId, accept: true, reason: '', actionId: crypto.randomUUID() }))}>Accept</button>
                    <button type="button" className={primaryButton} onClick={() => void call('decline-transfer', (current) => current.reducers.respondTransferTask({ transferId: item.transferId, accept: false, reason: reason || 'cant lift water', actionId: crypto.randomUUID() }))}>Decline</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    )
  }

  const task = row
  const place = task.kind === 'charging' ? resourceWords('charger_slot', task.accessible) : 'water'

  return (
    <div className="max-w-xl">
      <Link to="/v/tasks" className="text-sm text-muted">Tasks</Link>
      <h1 className="mt-3 text-3xl font-medium tracking-tight">
        {task.dispatchState === 'offered' ? 'Offered to you' : 'Owned by you'}: {task.residentLabel}, {place}.
      </h1>
      <p className="mt-3 text-muted">{task.units} {task.kind}</p>
      {error && (
        <div className="mt-4">
          <ErrorBanner title="Not saved" text={error} />
        </div>
      )}
      {task.dispatchState === 'offered' && (
        <div className="mt-6 flex flex-wrap gap-3">
          <button type="button" className={primaryButton} disabled={pending !== ''} onClick={() => void call('accept', (current) => current.reducers.acceptTask({ assignmentId: task.assignmentId, expectedVersion: task.dispatchVersion, actionId: crypto.randomUUID() }))}>Accept</button>
          <label className="text-sm">
            Decline reason
            <input value={reason} onChange={(event) => setReason(event.target.value)} className="mt-2 block min-h-12 border border-line bg-panel px-3" />
          </label>
          <button type="button" className={primaryButton} disabled={pending !== ''} onClick={() => void call('decline', (current) => current.reducers.declineTask({ assignmentId: task.assignmentId, reason: reason || 'cant lift water', actionId: crypto.randomUUID() }))}>Decline</button>
        </div>
      )}
      {task.dispatchState === 'accepted' && (
        <button type="button" className={`${primaryButton} mt-6`} disabled={pending !== ''} onClick={() => void call('start', (current) => current.reducers.startTask({ assignmentId: task.assignmentId, actionId: crypto.randomUUID() }))}>Start</button>
      )}
      {(task.dispatchState === 'accepted' || task.dispatchState === 'in_progress') && (
        <section className="mt-6 border border-line p-4">
          <h2 className="text-lg font-medium">Share location for this task</h2>
          <p className="mt-2 text-sm text-muted">Keep this phone open. Sharing is foreground-only and stops when you leave this task.</p>
          {!window.isSecureContext && <p className="mt-2 text-sm">This page is not a secure context, so the browser will not share location.</p>}
          {locationNote && <p className="mt-2 text-sm">{locationNote}</p>}
          <div className="mt-3 flex flex-wrap gap-3">
            <button
              type="button"
              className={primaryButton}
              disabled={sharing}
              onClick={() => {
                if (!window.isSecureContext || !navigator.geolocation) {
                  setLocationNote('Location is off. You can use check-in buttons instead.')
                  return
                }
                setLocationNote('')
                watchId.current = navigator.geolocation.watchPosition(
                  (position) => {
                    const current = connectionRef.current
                    if (!current) return
                    seq.current += 1n
                    setSharing(true)
                    setLocationNote(`± ${Math.round(position.coords.accuracy)} m · sent ${new Date().toLocaleTimeString()}`)
                    void runReducer(current, (live) =>
                      live.reducers.updateTaskLocation({
                        assignmentId: task.assignmentId,
                        transferId: 0n,
                        seq: seq.current,
                        lat: position.coords.latitude,
                        lon: position.coords.longitude,
                        accuracyM: position.coords.accuracy,
                        capturedAt: new Date(position.timestamp).toISOString().slice(0, 40),
                      }),
                    ).then((result) => {
                      if (!result.ok && result.code !== 'RATE_LIMIT') setError(result.text)
                    })
                  },
                  () => {
                    clearWatch()
                    setLocationNote('Location is off. You can use check-in buttons instead.')
                  },
                  { enableHighAccuracy: true, maximumAge: 5000 },
                )
              }}
            >
              Share location for this task
            </button>
            <button
              type="button"
              className={quietButton}
              onClick={() => {
                clearWatch()
                void call('stop-share', (current) => current.reducers.stopTaskLocation({ assignmentId: task.assignmentId, transferId: 0n }))
              }}
            >
              Stop sharing
            </button>
          </div>
          <p className="mt-4 text-sm text-muted">User-entered check-in, not GPS.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {(['picked_up', 'on_the_way', 'arrived'] as const).map((stage) => (
              <button
                key={stage}
                type="button"
                className={quietButton}
                onClick={() => void call(stage, (current) => current.reducers.checkInTask({ assignmentId: task.assignmentId, transferId: 0n, stage }))}
              >
                {stage === 'picked_up' ? 'Picked up' : stage === 'on_the_way' ? 'On my way' : 'Arrived'}
              </button>
            ))}
          </div>
        </section>
      )}
      {(task.dispatchState === 'accepted' || task.dispatchState === 'in_progress') && (
        <div className="mt-4 flex flex-wrap gap-3">
          <button type="button" className={primaryButton} disabled={pending !== ''} onClick={() => void call('done', (current) => current.reducers.completeAssignment({ assignmentId: task.assignmentId }))}>{pending === 'done' ? 'Marking done…' : 'Mark done'}</button>
          <button type="button" className="inline-flex min-h-12 items-center px-4 text-sm" disabled={pending !== ''} onClick={() => void call('cant', (current) => current.reducers.reportCantDo({ assignmentId: task.assignmentId, reason: reason || 'cant lift water', actionId: crypto.randomUUID() }))}>Can't do this</button>
        </div>
      )}
      {task.kind === 'charging' && task.state === 'delivered' && (
        <button type="button" className={`${primaryButton} mt-6`} disabled={pending !== ''} onClick={() => void call('end', (current) => current.reducers.endChargingSession({ assignmentId: task.assignmentId, actionId: crypto.randomUUID() }))}>End session</button>
      )}
      {task.state === 'delivered' && task.kind !== 'charging' && <p className="mt-4 text-sm">Marked delivered. The resident still confirms it.</p>}
    </div>
  )
}
