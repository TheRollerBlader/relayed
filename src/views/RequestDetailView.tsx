import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Dialog, primaryButton } from '../components/Dialog'
import { ErrorBanner } from '../components/ErrorBanner'
import { StatusBadge } from '../components/StatusBadge'
import { reasonWords, serverBadge } from '../lib/copy'
import { tables } from '../module_bindings/index.ts'
import { runReducer, useConnection } from '../lib/server'
import { useRows } from '../lib/tables'

export function RequestDetailView() {
  const { requestPk = '' } = useParams()
  const connection = useConnection()
  const [rows] = useRows(tables.coordinatorQueue)
  const [events] = useRows(tables.recentEvents)
  const [board] = useRows(tables.coordinatorBoard)
  const [followUps] = useRows(tables.coordinatorFollowUps)
  const row = rows.find((item) => item.requestPk.toString() === requestPk)
  const history = events.filter((event) => event.subjectId === requestPk && event.type.startsWith('request_'))
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState('')
  const [rejectReason, setRejectReason] = useState('out_of_scope')
  const [cancelReason, setCancelReason] = useState('staff_cancelled')
  const [priority, setPriority] = useState('1')
  const [priorityReason, setPriorityReason] = useState('staff set')
  const [splitUnits, setSplitUnits] = useState('1')
  const [confirm, setConfirm] = useState<null | 'reject' | 'cancel'>(null)

  async function acknowledge() {
    if (!row) return
    setPending('acknowledge')
    setError(null)
    const result = await runReducer(connection, (current) =>
      current.reducers.acknowledgeRequest({
        requestPk: row.requestPk,
        expectedStateVersion: row.stateVersion,
      }),
    )
    setPending('')
    if (!result.ok) setError(result.text)
  }

  async function applyPriority() {
    if (!row) return
    setPending('priority')
    setError(null)
    const result = await runReducer(connection, (current) =>
      current.reducers.setHumanPriority({
        requestPk: row.requestPk,
        level: Number(priority),
        reasonCode: 'staff_set',
        reason: priorityReason,
      }),
    )
    setPending('')
    if (!result.ok) setError(result.text)
  }

  async function confirmAction() {
    if (!row || !confirm) return
    const reason = confirm === 'reject' ? rejectReason : cancelReason
    setPending(confirm)
    setError(null)
    const action = confirm
    setConfirm(null)
    const result = await runReducer(connection, (current) =>
      action === 'reject'
        ? current.reducers.rejectRequest({ requestPk: row.requestPk, reasonCode: reason })
        : current.reducers.cancelRequest({ requestPk: row.requestPk, reasonCode: reason }),
    )
    setPending('')
    if (!result.ok) setError(result.text)
  }

  if (!row) return <p className="text-muted">That request is not in this queue.</p>

  return (
    <div className="max-w-2xl">
      <Link to="/c/queue" className="text-sm text-muted">
        Queue
      </Link>
      <h1 className="mt-3 text-3xl font-medium">{row.residentLabel}</h1>
      <div className="mt-4">
        <StatusBadge status={serverBadge(row.state)} />
      </div>
      <p className="mt-4 text-muted">{reasonWords(row.waitReason)}</p>
      {error && (
        <div className="mt-4">
          <ErrorBanner title="Not saved" text={error} />
        </div>
      )}
      <div className="mt-6 flex flex-wrap gap-3">
        {row.state === 'received' && (
          <button type="button" disabled={!connection || pending !== ''} onClick={() => void acknowledge()} className={primaryButton}>
            {pending === 'acknowledge' ? 'Acknowledging…' : 'Acknowledge'}
          </button>
        )}
      </div>
      <fieldset className="mt-8 border border-line bg-panel p-4" disabled={!connection || pending !== ''}>
        <legend className="px-2 text-sm">Reject</legend>
        <select value={rejectReason} onChange={(event) => setRejectReason(event.target.value)} className="mt-2 min-h-12 border border-line bg-canvas px-3">
          <option value="out_of_scope">Out of scope</option>
          <option value="invalid_request">Invalid request</option>
        </select>
        <button type="button" onClick={() => setConfirm('reject')} className={`${quietButton} mt-3`}>
          Reject
        </button>
      </fieldset>
      <fieldset className="mt-4 border border-line bg-panel p-4" disabled={!connection || pending !== ''}>
        <legend className="px-2 text-sm">Cancel</legend>
        <select value={cancelReason} onChange={(event) => setCancelReason(event.target.value)} className="mt-2 min-h-12 border border-line bg-canvas px-3">
          <option value="staff_cancelled">Staff cancelled</option>
          <option value="duplicate">Duplicate</option>
        </select>
        <button type="button" onClick={() => setConfirm('cancel')} className={`${quietButton} mt-3`}>
          Cancel
        </button>
      </fieldset>
      {row.state === 'assigned' && board.find((item) => item.requestPk === row.requestPk && item.state === 'reserved') && (
        <button
          type="button"
          className={`${primaryButton} mt-4`}
          disabled={!connection || pending !== ''}
          onClick={() => {
            const assignment = board.find((item) => item.requestPk === row.requestPk && item.state === 'reserved')
            if (!assignment) return
            setPending('release')
            void runReducer(connection, (current) =>
              current.reducers.releaseAssignment({ assignmentId: assignment.assignmentId, reasonCode: 'resident_declined' }),
            ).then((result) => {
              setPending('')
              if (!result.ok) setError(result.text)
            })
          }}
        >
          Release assignment
        </button>
      )}
      {row.state === 'delivered' && (
        <button
          type="button"
          className={`${primaryButton} mt-4`}
          disabled={!connection || pending !== ''}
          onClick={() => {
            setPending('verify')
            void runReducer(connection, (current) =>
              current.reducers.confirmDelivery({ requestPk: row.requestPk, actionId: crypto.randomUUID() }),
            ).then((result) => {
              setPending('')
              if (!result.ok) setError(result.text)
            })
          }}
        >
          Staff verified
        </button>
      )}
      {row.kind === 'water' && row.state === 'assigned' && (
        <fieldset className="mt-4 border border-line bg-panel p-4">
          <legend className="px-2 text-sm">Partial water</legend>
          <p className="mt-2 text-sm text-muted">Deliver some now and leave the rest as a backorder. Stock stays conserved.</p>
          <input value={splitUnits} onChange={(event) => setSplitUnits(event.target.value)} className="mt-2 min-h-12 border border-line bg-canvas px-3" />
          <button
            type="button"
            className={`${quietButton} mt-3`}
            disabled={!connection || pending !== ''}
            onClick={() => {
              setPending('split')
              void runReducer(connection, (current) =>
                current.reducers.splitFulfillment({ requestPk: row.requestPk, units: Number(splitUnits), actionId: crypto.randomUUID() }),
              ).then((result) => {
                setPending('')
                if (!result.ok) setError(result.text)
              })
            }}
          >
            Split fulfillment
          </button>
        </fieldset>
      )}
      <fieldset className="mt-4 border border-line bg-panel p-4">
        <legend className="px-2 text-sm">Serve by</legend>
        <button
          type="button"
          className={`${quietButton} mt-3`}
          disabled={!connection || pending !== ''}
          onClick={() => {
            setPending('deadline')
            void runReducer(connection, (current) =>
              current.reducers.setServeBy({ requestPk: row.requestPk, deadlineMicros: BigInt(Date.now() + 60 * 60 * 1000) * 1000n }),
            ).then((result) => {
              setPending('')
              if (!result.ok) setError(result.text)
            })
          }}
        >
          Should be served within an hour
        </button>
      </fieldset>
      {followUps.filter((item) => item.requestPk === row.requestPk).map((item) => (
        <p key={item.followUpId.toString()} className="mt-4 text-sm">
          Follow-up {item.reason.replaceAll('_', ' ')} · {item.state.replaceAll('_', ' ')}
          {item.ownerLabel ? ` · ${item.ownerLabel}` : ' · no owner yet'}
          <button
            type="button"
            className={`${quietButton} ml-3`}
            onClick={() =>
              void runReducer(connection, (current) =>
                current.reducers.assignFollowUp({
                  followUpId: item.followUpId,
                  deadlineMicros: BigInt(Date.now() + 2 * 60 * 60 * 1000) * 1000n,
                  actionId: crypto.randomUUID(),
                }),
              )
            }
          >
            Take follow-up
          </button>
        </p>
      ))}
      <fieldset className="mt-4 border border-line bg-panel p-4" disabled={!connection || pending !== ''}>
        <legend className="px-2 text-sm">Priority</legend>
        <p className="mt-2 text-sm text-muted">A person sets this, with a reason. No inferred urgency.</p>
        <input value={priorityReason} onChange={(event) => setPriorityReason(event.target.value)} className="mt-2 block min-h-12 w-full border border-line bg-canvas px-3" />
        <select value={priority} onChange={(event) => setPriority(event.target.value)} className="mt-2 min-h-12 border border-line bg-canvas px-3">
          <option value="1">1</option>
          <option value="2">2</option>
          <option value="3">3</option>
        </select>
        <button type="button" onClick={() => void applyPriority()} className={`${quietButton} mt-3`}>
          {pending === 'priority' ? 'Saving…' : 'Set priority'}
        </button>
      </fieldset>
      {history.length > 0 && (
        <section className="mt-8">
          <h2 className="font-mono text-[11px] tracking-[0.16em] text-faint">HISTORY</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {history.map((event) => (
              <li key={event.eventId.toString()}>
                {event.type.replaceAll('_', ' ')}
              </li>
            ))}
          </ul>
        </section>
      )}
      {confirm && (
        <Dialog
          title={confirm === 'reject' ? 'Reject this request?' : 'Cancel this request?'}
          body={
            confirm === 'reject'
              ? `This marks the request not accepted: ${reasonWords(rejectReason)}.`
              : `This cancels the request: ${reasonWords(cancelReason)}.`
          }
          confirmLabel={pending ? 'Saving…' : 'Confirm'}
          onConfirm={() => void confirmAction()}
          onClose={() => setConfirm(null)}
        />
      )}
    </div>
  )
}

const quietButton =
  'inline-flex min-h-12 items-center border border-line px-4 text-sm hover:border-accent disabled:text-faint'
