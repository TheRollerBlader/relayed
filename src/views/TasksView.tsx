import { Link } from 'react-router-dom'
import { StatusBadge } from '../components/StatusBadge'
import { taskBadge } from '../lib/copy'
import { tables } from '../module_bindings/index.ts'
import { useRows } from '../lib/tables'

export function TasksView() {
  const [rows, ready] = useRows(tables.myAssignments)

  return (
    <div className="max-w-xl">
      <p className="font-mono text-[11px] tracking-[0.18em] text-accent">VOLUNTEER</p>
      <h1 className="mt-3 text-4xl font-medium tracking-tight">Your tasks</h1>
      {!ready && <p className="mt-4 text-sm text-muted">Connecting to the shelter system…</p>}
      {ready && rows.length === 0 && <p className="mt-6 text-muted">No tasks assigned to you right now.</p>}
      <ul className="mt-6 divide-y divide-line border border-line bg-panel">
        {rows.map((row) => (
          <li key={row.assignmentId.toString()}>
            <Link to={`/v/tasks/${row.assignmentId.toString()}`} className="flex min-h-16 flex-wrap items-center justify-between gap-3 px-4 py-3">
              <span>
                <span className="block">{row.residentLabel}</span>
                <span className="mt-1 block text-sm text-muted">{row.kind}</span>
              </span>
              <StatusBadge status={taskBadge(row.dispatchState, row.state)} />
            </Link>
          </li>
        ))}
      </ul>
      <p className="mt-6 text-sm text-muted">Can't do this? Tell the coordinator.</p>
    </div>
  )
}
