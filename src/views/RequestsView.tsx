import { Link } from 'react-router-dom'
import { StatusBadge } from '../components/StatusBadge'
import { localBadge, requestWords, serverBadge } from '../lib/copy'
import { useOutbox } from '../lib/outboxClient'
import { tables } from '../module_bindings/index.ts'
import { useRows } from '../lib/tables'

export function RequestsView() {
  const { items } = useOutbox()
  const [requests, ready] = useRows(tables.myRequests)
  const serverIds = new Set(requests.map((row) => row.clientRequestId))
  const localOnly = items.filter((item) => !serverIds.has(item.clientRequestId))

  return (
    <div className="max-w-xl">
      <p className="font-mono text-[11px] tracking-[0.18em] text-accent">RESIDENT</p>
      <h1 className="mt-3 text-4xl font-medium tracking-tight">Your requests</h1>
      {!ready && <p className="mt-4 text-sm text-muted">Connecting to the shelter system…</p>}
      {ready && localOnly.length === 0 && requests.length === 0 && (
        <p className="mt-6 text-muted">No request yet. Your receipt stays on this device, including while you are offline.</p>
      )}
      <ul className="mt-6 divide-y divide-line border border-line bg-panel">
        {localOnly.map((item) => (
          <li key={item.clientRequestId}>
            <Link to={`/r/requests/${item.clientRequestId}`} className="flex min-h-16 flex-wrap items-center justify-between gap-3 px-4 py-3">
              <span>{requestWords(item.kind, item.needs[0] ?? '', item.quantity)}</span>
              <StatusBadge status={localBadge(item.status, item.notice)} />
            </Link>
          </li>
        ))}
        {requests.map((row) => (
          <li key={row.clientRequestId}>
            <Link to={`/r/requests/${row.clientRequestId}`} className="flex min-h-16 flex-wrap items-center justify-between gap-3 px-4 py-3">
              <span>{requestWords(row.kind, row.needs, row.quantity)}</span>
              <StatusBadge status={serverBadge(row.state)} />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
