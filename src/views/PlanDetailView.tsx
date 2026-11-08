import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Dialog, primaryButton, quietButton } from '../components/Dialog'
import { ErrorBanner } from '../components/ErrorBanner'
import { reasonWords } from '../lib/copy'
import { tables } from '../module_bindings/index.ts'
import { runReducer, useConnection } from '../lib/server'
import { useRows } from '../lib/tables'
import { groupPlans } from './planGroups'

export function PlanDetailView() {
  const { planId = '' } = useParams()
  const connection = useConnection()
  const [rows] = useRows(tables.coordinatorPlanDetails)
  const group = groupPlans(rows).find((item) => item.head.planId.toString() === planId)
  const [pending, setPending] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<null | 'approve' | 'reject'>(null)
  const [approvalId, setApprovalId] = useState<string | null>(null)

  if (!group) return <p className="text-muted">That plan is not on this desk.</p>

  const plan = group.head
  const stale = plan.inputSnapshotVersion !== plan.liveSnapshotVersion
  const canApprove = Boolean(connection) && !stale && !plan.hypothetical && plan.status === 'proposed' && pending === ''

  const approve = async () => {
    if (!connection || !canApprove) return
    const id = approvalId ?? crypto.randomUUID()
    setApprovalId(id)
    setPending('approve')
    setError(null)
    const result = await runReducer(connection, (current) =>
      current.reducers.approvePlan({
        planId: plan.planId,
        expectedSnapshotVersion: plan.inputSnapshotVersion,
        approvalId: id,
      }),
    )
    setPending('')
    if (!result.ok) setError(result.text)
  }

  const reject = async () => {
    if (!connection) return
    setConfirm(null)
    setPending('reject')
    setError(null)
    const result = await runReducer(connection, (current) =>
      current.reducers.rejectPlan({ planId: plan.planId, reasonCode: 'staff_rejected' }),
    )
    setPending('')
    if (!result.ok) setError(result.text)
  }

  const approved = group.head.status === 'approved'
  const waterUnits = group.served.filter((row) => row.requestKind === 'water').reduce((sum, row) => sum + row.units, 0)
  const chargerSlots = group.served.filter((row) => row.requestKind !== 'water').reduce((sum, row) => sum + Math.max(1, row.units), 0)
  const reserved = [
    chargerSlots > 0 ? `${chargerSlots} charger slot${chargerSlots === 1 ? '' : 's'}` : '',
    waterUnits > 0 ? `${waterUnits} water unit${waterUnits === 1 ? '' : 's'}` : '',
  ].filter(Boolean)
  const approveEffect = reserved.length > 0 ? `This reserves ${reserved.join(' and ')}.` : 'No one is matched, so this reserves nothing.'

  return (
    <div>
      <Link to="/c/plans" className="text-sm text-muted">
        Plans
      </Link>
      <h1 className="mt-3 text-3xl font-medium capitalize">{group.head.strategy.replaceAll('_', ' ')}</h1>
      <p className="mt-3 text-muted">{group.head.summary}</p>
      <p className="mt-2 font-mono text-xs text-faint">
        Snapshot {group.head.inputSnapshotVersion.toString()} · Live {group.head.liveSnapshotVersion.toString()}
      </p>
      {group.head.hypothetical && (
        <p className="mt-4 text-sm">Hypothetical: not real stock. Nothing was changed.</p>
      )}
      {stale && <p className="mt-4 text-sm">Out of date: things changed since this plan was made. Regenerate.</p>}
      {approved && <p className="mt-4 text-sm">This plan was already approved.</p>}
      {error && (
        <div className="mt-4 max-w-xl">
          <ErrorBanner title="Not approved" text={error} />
        </div>
      )}
      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <section className="border border-line bg-panel p-4">
          <h2 className="font-mono text-[11px] tracking-[0.16em] text-faint">MATCHED</h2>
          {group.served.length === 0 && <p className="mt-2 text-sm text-muted">No one is matched.</p>}
          <ul className="mt-2 space-y-2 text-sm">
            {group.served.map((row) => (
              <li key={row.lineId}>
                {row.residentLabel} · {row.requestKind} · {row.resourceId}
              </li>
            ))}
          </ul>
        </section>
        <section className="border border-line bg-panel p-4">
          <h2 className="font-mono text-[11px] tracking-[0.16em] text-faint">LEFT OUT</h2>
          {group.unmatched.length === 0 && <p className="mt-2 text-sm text-muted">No one is left out.</p>}
          <ul className="mt-2 space-y-2 text-sm">
            {group.unmatched.map((row) => (
              <li key={row.lineId}>
                {row.residentLabel}
                <span className="block text-muted">{reasonWords(row.reason)}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
      <div className="mt-6 flex flex-wrap gap-3">
        <button type="button" disabled={!canApprove} onClick={() => setConfirm('approve')} className={primaryButton}>
          {pending === 'approve' ? 'Approving…' : 'Approve this plan'}
        </button>
        <button type="button" disabled={!connection || group.head.status === 'rejected' || pending !== ''} onClick={() => setConfirm('reject')} className={quietButton}>
          Reject plan
        </button>
      </div>
      <aside className="mt-8 max-w-xl border border-line p-4">
        <h2 className="font-mono text-[11px] tracking-[0.16em] text-faint">ASSISTANT</h2>
        <p className="mt-3 text-sm">
          Method {group.head.method}. {group.head.hypothetical ? 'Estimated only. This cannot be approved and does not create stock.' : 'Deterministic plan. A live model trace appears on the plans desk.'}
        </p>
      </aside>
      {confirm && (
        <Dialog
          title={confirm === 'approve' ? 'Approve this plan?' : 'Reject this plan?'}
          body={confirm === 'approve' ? approveEffect : 'Nothing is reserved. The plan is discarded.'}
          confirmLabel={confirm === 'approve' ? 'Approve this plan' : 'Reject plan'}
          onConfirm={() => {
            const action = confirm
            setConfirm(null)
            if (action === 'approve') void approve()
            else void reject()
          }}
          onClose={() => setConfirm(null)}
        />
      )}
    </div>
  )
}
