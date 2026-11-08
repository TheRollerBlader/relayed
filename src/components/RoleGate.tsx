import { Navigate, Outlet } from 'react-router-dom'
import { spacetimeEnabled, type DemoRole } from '../lib/config'
import { tables } from '../module_bindings/index.ts'
import { useSession } from '../lib/session'
import { useRows } from '../lib/tables'

export function RoleGate({ role }: { role: DemoRole }) {
  const session = useSession()
  const [rows, ready] = useRows(tables.myMembership)
  if (session.accessReason) return <Navigate to="/access" replace />
  if (!spacetimeEnabled) {
    if (!session.role) return <Navigate to="/" replace />
    if (session.role !== role) return <Navigate to="/access" replace />
    return <Outlet />
  }
  if (!ready) return <p className="text-muted">Connecting to the shelter system…</p>
  const mine = rows[0]
  if (!mine || !mine.active) return <Navigate to="/" replace />
  if (mine.role !== role) return <Navigate to="/access" replace />
  return <Outlet />
}
