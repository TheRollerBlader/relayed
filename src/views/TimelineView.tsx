import { useMemo, useState } from 'react'
import { formatWhen, timestampMs } from '../lib/copy'
import { tables } from '../module_bindings/index.ts'
import { useRows } from '../lib/tables'

export function TimelineView() {
  const [rows] = useRows(tables.coordinatorTimeline)
  const [query, setQuery] = useState('')
  const visible = useMemo(() => {
    const needle = query.trim()
    return rows.filter((row) => {
      if (!needle) return true
      return row.requestKey.includes(needle) || row.transferKey.includes(needle) || row.subjectId.includes(needle)
    })
  }, [query, rows])

  return (
    <div>
      <p className="font-mono text-[11px] tracking-[0.18em] text-accent">COORDINATOR</p>
      <h1 className="mt-3 text-4xl font-medium tracking-tight">Incident timeline</h1>
      <p className="mt-3 max-w-2xl text-muted">Requests, tasks, transfers, and assistant steps in order. Location shows only that sharing started or stopped.</p>
      <label className="mt-6 block text-sm">
        Filter by request or transfer
        <input value={query} onChange={(event) => setQuery(event.target.value)} className="mt-2 block min-h-12 w-full max-w-md border border-line bg-panel px-3" />
      </label>
      <ol className="mt-6 divide-y divide-line border border-line bg-panel">
        {visible.map((row) => (
          <li key={row.lineId} className="px-4 py-3">
            <p className="text-sm">{row.summary}</p>
            <p className="mt-1 font-mono text-xs text-faint">
              {formatWhen(timestampMs(row.at))} · {row.kind}
              {row.subjectId ? ` · ${row.subjectId}` : ''}
            </p>
          </li>
        ))}
      </ol>
      {visible.length === 0 && <p className="mt-4 text-sm text-muted">No events for that filter.</p>}
    </div>
  )
}
