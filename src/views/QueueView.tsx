import { useEffect, useState } from 'react'
import { InvitePanel } from './InvitePanel'
import { Link } from 'react-router-dom'
import { StatusBadge } from '../components/StatusBadge'
import { formatWait, reasonWords, serverBadge, timestampMs } from '../lib/copy'
import { canUseServer, useSession } from '../lib/session'
import { tables } from '../module_bindings/index.ts'
import { useRows } from '../lib/tables'

export function QueueView() {
  const session = useSession()
  const [rows, ready] = useRows(tables.coordinatorQueue)
  const [status, setStatus] = useState('all')
  const [kind, setKind] = useState('all')
  const [accessibleOnly, setAccessibleOnly] = useState(false)
  const [now, setNow] = useState(0)
  useEffect(() => {
    const update = () => setNow(Date.now())
    update()
    const timer = window.setInterval(update, 30_000)
    return () => window.clearInterval(timer)
  }, [])
  const filtered = rows.filter((row) => {
    if (status !== 'all' && row.state !== status) return false
    if (kind !== 'all' && row.kind !== kind) return false
    if (accessibleOnly && row.needs !== 'accessible_slot') return false
    return true
  })

  return (
    <div>
      <p className="font-mono text-[11px] tracking-[0.18em] text-accent">COORDINATOR</p>
      <h1 className="mt-3 text-4xl font-medium tracking-tight">Who is still waiting</h1>
      <p className="mt-3 max-w-2xl text-muted">People no one has seen, and people a plan cannot serve, stay above the rest.</p>
      {!canUseServer(session) && (
        <p className="mt-4 border border-line bg-panel px-4 py-3 text-sm" role="status">
          Not connected; this list may be out of date (last update {session.lastUpdate ? new Date(session.lastUpdate).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'not yet'}).
        </p>
      )}
      <div className="mt-6 flex flex-wrap gap-3">
        <label className="text-sm">
          Status
          <select value={status} onChange={(event) => setStatus(event.target.value)} className="mt-1 block min-h-12 border border-line bg-panel px-3">
            <option value="all">All</option>
            <option value="received">Delivered</option>
            <option value="acknowledged">Seen</option>
            <option value="assigned">Assigned</option>
            <option value="completed">Completed</option>
          </select>
        </label>
        <label className="text-sm">
          Type
          <select value={kind} onChange={(event) => setKind(event.target.value)} className="mt-1 block min-h-12 border border-line bg-panel px-3">
            <option value="all">All</option>
            <option value="water">Water</option>
            <option value="charging">Charging</option>
          </select>
        </label>
        <label className="flex min-h-12 items-end gap-2 text-sm">
          <input type="checkbox" checked={accessibleOnly} onChange={(event) => setAccessibleOnly(event.target.checked)} className="size-5 accent-accent" />
          Accessible only
        </label>
      </div>
      {!ready && <p className="mt-6 text-sm text-muted">Connecting to the shelter system…</p>}
      {ready && rows.length === 0 && (
        <p className="mt-6 text-muted">No open requests right now. New requests will appear here automatically.</p>
      )}
      {ready && rows.length > 0 && filtered.length === 0 && (
        <p className="mt-6 text-muted">No requests match these filters.</p>
      )}
      <ul className="mt-4 divide-y divide-line border border-line bg-panel">
        {filtered.map((row) => {
          const received = timestampMs(row.receivedAt)
          return (
            <li key={row.requestPk.toString()}>
              <Link to={`/c/requests/${row.requestPk.toString()}`} className="block px-4 py-4 hover:bg-panel-2">
                <span className="flex flex-wrap items-start justify-between gap-3">
                  <span>
                    <span className="block font-medium">{row.residentLabel}</span>
                    <span className="mt-1 block font-mono text-xs text-faint">
                      {row.kind === 'water' ? 'Water' : row.needs === 'accessible_slot' ? 'Accessible charging' : 'Charging'} · {row.quantity}
                    </span>
                  </span>
                  <StatusBadge status={serverBadge(row.state)} />
                </span>
                <span className="mt-3 block text-sm text-muted">
                  {row.overdue ? 'Overdue · ' : ''}
                  {received === null ? 'Waiting' : `Waiting ${formatWait(received, now)}`} · {reasonWords(row.waitReason)}
                  {row.priorityReason ? ` · ${row.priorityReason}` : ''}
                </span>
              </Link>
            </li>
          )
        })}
      </ul>
      <InvitePanel />
    </div>
  )
}
