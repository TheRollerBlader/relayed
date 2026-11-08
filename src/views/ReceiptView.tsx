import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Dialog, primaryButton } from '../components/Dialog'
import { ErrorBanner } from '../components/ErrorBanner'
import { StatusBadge } from '../components/StatusBadge'
import {
  formatWhen,
  localBadge,
  localSentence,
  requestWords,
  serverBadge,
  serverSentence,
  timestampMs,
} from '../lib/copy'
import { retryRequest, saveRequest, useOutbox } from '../lib/outboxClient'
import { useSession } from '../lib/session'
import { tables } from '../module_bindings/index.ts'
import { runReducer, useConnection } from '../lib/server'
import { useRows } from '../lib/tables'

function freshStamp() {
  return { iso: new Date().toISOString(), ms: Date.now() }
}

export function ReceiptView() {
  const { clientRequestId = '' } = useParams()
  const connection = useConnection()
  const session = useSession()
  const { items, ready } = useOutbox()
  const [requests, requestsReady] = useRows(tables.myRequests)
  const [policyRows] = useRows(tables.sessionShelter)
  const [progress] = useRows(tables.myProgress)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const server = requests.find((row) => row.clientRequestId === clientRequestId)
  const local = items.find((item) => item.clientRequestId === clientRequestId)

  async function cancel() {
    if (!server) return
    setPending(true)
    setError(null)
    const result = await runReducer(connection, (current) =>
      current.reducers.cancelRequest({ requestPk: server.requestPk, reasonCode: 'resident_cancelled' }),
    )
    setPending(false)
    if (!result.ok) setError(result.text)
  }

  async function sendAsNew() {
    if (!local) return
    const created = freshStamp()
    const nextId = crypto.randomUUID()
    await saveRequest({
      clientRequestId: nextId,
      shelterId: session.shelterId,
      kind: local.kind,
      needs: local.needs,
      quantity: local.quantity,
      clientCreatedAt: created.iso,
      savedAtMs: created.ms,
    })
    window.location.assign(`/r/requests/${nextId}`)
  }

  if (!ready || !requestsReady) {
    return <p className="text-muted">Connecting to the shelter system…</p>
  }

  if (!server && !local) {
    return <p className="text-muted">That request is not on this device.</p>
  }

  const sentence = server ? serverSentence(server.state, server.cancelReason) : localSentence(local?.notice ?? '', local?.status ?? 'saved_on_device')
  const badge = server ? serverBadge(server.state) : localBadge(local?.status ?? 'saved_on_device', local?.notice ?? '')
  const confirmed = server ? timestampMs(server.updatedAt) : null
  const canCancel = server && (server.state === 'received' || server.state === 'acknowledged')
  const policy = policyRows[0]
  const needsConfirm = server && ((server.kind === 'water' && policy?.confirmWater) || (server.kind === 'charging' && policy?.confirmCharging))

  return (
    <div className="max-w-xl">
      <p className="font-mono text-[11px] tracking-[0.18em] text-accent">RECEIPT</p>
      <h1 className="mt-3 text-3xl font-medium tracking-tight">
        {requestWords(server?.kind ?? local?.kind ?? 'water', server?.needs ?? local?.needs[0] ?? '', server?.quantity ?? local?.quantity ?? 1)}
      </h1>
      <div className="mt-4" aria-live="polite">
        <StatusBadge status={badge} />
        <p className="mt-4 text-lg">{sentence}</p>
        {server && progress.find((item) => item.requestPk === server.requestPk)?.sentence && (
          <p className="mt-2 text-sm">{progress.find((item) => item.requestPk === server.requestPk)?.sentence}</p>
        )}
      </div>
      <p className="mt-4 font-mono text-xs text-faint">Request {clientRequestId.slice(0, 8)}</p>
      <p className="mt-2 text-sm text-muted">
        Last confirmed by the shelter system: {confirmed === null ? 'not yet' : formatWhen(confirmed)}
      </p>
      {error && (
        <div className="mt-4">
          <ErrorBanner title="Not cancelled" text={error} />
        </div>
      )}
      {local?.notice === 'IDEMPOTENCY_CONFLICT' && (
        <button type="button" onClick={() => void sendAsNew()} className={`${primaryButton} mt-4`}>
          Send it as a new request
        </button>
      )}
      {local?.notice === 'CHECKING' && (
        <button type="button" onClick={() => void retryRequest(clientRequestId)} className={`${primaryButton} mt-4`}>
          Try the same request again
        </button>
      )}
      {needsConfirm && <p className="mt-4 text-sm text-muted">This shelter asks you to confirm {server?.kind === 'water' ? 'water' : 'charging'}.</p>}
      {server?.state === 'delivered' && (
        <div className="mt-4 flex flex-wrap gap-3">
          <button type="button" className={primaryButton} disabled={!connection || pending} onClick={() => void runReducer(connection, (current) => current.reducers.confirmDelivery({ requestPk: server.requestPk, actionId: crypto.randomUUID() }))}>Yes, I got it</button>
          <button type="button" className={primaryButton} disabled={!connection || pending} onClick={() => void runReducer(connection, (current) => current.reducers.disputeDelivery({ requestPk: server.requestPk, actionId: crypto.randomUUID() }))}>I didn't get it</button>
          <button type="button" className={primaryButton} disabled={!connection || pending} onClick={() => void runReducer(connection, (current) => current.reducers.cantReceive({ requestPk: server.requestPk, actionId: crypto.randomUUID() }))}>I can't receive help right now</button>
        </div>
      )}
      {server?.state === 'assigned' && (
        <p className="mt-4 text-sm">Staff must release this before it can be cancelled.</p>
      )}
      {canCancel && (
        <button type="button" disabled={!connection || pending} onClick={() => setConfirmCancel(true)} className={`${primaryButton} mt-6`}>
          {pending ? 'Cancelling…' : 'Cancel request'}
        </button>
      )}
      {confirmCancel && (
        <Dialog
          title="Cancel this request?"
          body="This asks the shelter system to cancel it. The receipt changes only after the server confirms."
          confirmLabel={pending ? 'Cancelling…' : 'Cancel request'}
          onConfirm={() => {
            setConfirmCancel(false)
            void cancel()
          }}
          onClose={() => setConfirmCancel(false)}
        />
      )}
      <Link to="/r/requests" className="mt-6 inline-flex min-h-12 items-center text-sm text-muted">
        All receipts
      </Link>
    </div>
  )
}
