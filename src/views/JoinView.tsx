import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { primaryButton } from '../components/Dialog'
import { demoMode, homeFor, type DemoRole } from '../lib/config'
import { tables } from '../module_bindings/index.ts'
import { runReducer, useConnection } from '../lib/server'
import { useSession } from '../lib/session'
import { useRows } from '../lib/tables'

export function JoinView() {
  const { inviteId = '' } = useParams()
  const connection = useConnection()
  const session = useSession()
  const navigate = useNavigate()
  const [membership] = useRows(tables.myMembership)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const mine = membership[0]

  async function accept() {
    setPending(true)
    setError(null)
    const result = await runReducer(connection, (current) => current.reducers.acceptInvite({ inviteId }))
    setPending(false)
    if (!result.ok) {
      setError(result.text)
      return
    }
  }

  if (!demoMode && !connection) {
    return (
      <div className="max-w-xl">
        <h1 className="text-4xl font-medium">Sign in before joining</h1>
        <p className="mt-3 text-muted">This link does not sign you in by itself.</p>
      </div>
    )
  }

  return (
    <div className="max-w-xl">
      <p className="font-mono text-[11px] tracking-[0.18em] text-accent">JOIN</p>
      <h1 className="mt-3 text-4xl font-medium">Join this shelter</h1>
      <p className="mt-3 text-muted">The invite can add a resident or a volunteer. It cannot make a coordinator.</p>
      {mine && <p className="mt-4 text-sm">This account is the {mine.role}.</p>}
      {error && <p className="mt-4 text-sm">{error}</p>}
      <button type="button" className={`${primaryButton} mt-6`} disabled={!connection || pending} onClick={() => void accept()}>
        {pending ? 'Joining…' : 'Accept invite'}
      </button>
      {mine && (mine.role === 'resident' || mine.role === 'coordinator' || mine.role === 'volunteer') && (
        <button type="button" className="mt-4 block min-h-12 text-accent" onClick={() => navigate(homeFor(mine.role as DemoRole))}>
          Continue
        </button>
      )}
      {!mine && session.role && <p className="mt-4 text-sm text-muted">Waiting for the shelter to confirm the role.</p>}
    </div>
  )
}
