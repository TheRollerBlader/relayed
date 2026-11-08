import { useState } from 'react'
import { primaryButton } from '../components/Dialog'
import { ErrorBanner } from '../components/ErrorBanner'
import { useSession } from '../lib/session'
import { tables } from '../module_bindings/index.ts'
import { runReducer, useConnection } from '../lib/server'
import { useRows } from '../lib/tables'

export function AidView() {
  const session = useSession()
  const connection = useConnection()
  const [rows] = useRows(tables.coordinatorTransfers)
  const [resources] = useRows(tables.coordinatorResources)
  const [volunteers] = useRows(tables.coordinatorVolunteers)
  const [plans] = useRows(tables.coordinatorPlanDetails)
  const [quantity, setQuantity] = useState('2')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState('')
  const leftOut = plans.filter((row) => row.lineKind === 'unmatched' && row.reason === 'capacity_exhausted' && row.requestKind === 'water')

  async function call(id: string, action: (current: NonNullable<typeof connection>) => Promise<void>) {
    setPending(id)
    setError(null)
    const result = await runReducer(connection, action)
    setPending('')
    if (!result.ok) setError(result.text)
  }

  return (
    <div className="max-w-3xl">
      <p className="font-mono text-[11px] tracking-[0.18em] text-accent">COORDINATOR</p>
      <h1 className="mt-3 text-4xl font-medium tracking-tight">Mutual aid</h1>
      <p className="mt-3 text-muted">
        The other hall sees the kind and the quantity. Resident names stay in this shelter.
      </p>
      {leftOut.length > 0 && (
        <p className="mt-4 border border-line bg-panel px-4 py-3 text-sm">
          Water: {leftOut.length} request{leftOut.length === 1 ? '' : 's'} left out for capacity.
        </p>
      )}
      {error && (
        <div className="mt-4">
          <ErrorBanner title="Not saved" text={error} />
        </div>
      )}
      <div className="mt-6 flex flex-wrap items-end gap-3">
        <label className="text-sm">
          Water to ask for
          <input value={quantity} onChange={(event) => setQuantity(event.target.value)} className="mt-2 block min-h-12 w-28 border border-line bg-panel px-3" />
        </label>
        <button
          type="button"
          disabled={!connection || pending !== ''}
          onClick={() =>
            void call('ask', (current) =>
              current.reducers.createShortage({ kind: 'water_stock', quantity: Number(quantity), actionId: crypto.randomUUID() }),
            )
          }
          className={primaryButton}
        >
          Ask the other hall
        </button>
      </div>
      <ul className="mt-6 space-y-4">
        {rows.map((row) => {
          const mineIsSource = row.sourceShelterId === session.shelterId
          const water = resources.find((item) => item.kind === 'water_stock')
          const carriers = volunteers.filter((person) => person.available && person.canCarryWater)
          return (
            <li key={row.transferId.toString()} className="border border-line bg-panel p-4">
              <p className="font-medium">
                {row.sourceName} → {row.destName}
              </p>
              <p className="mt-1 text-sm text-muted">
                {row.kind === 'water_stock' ? 'Water' : 'Charging'} · asked {row.quantityRequested} · offered {row.quantityOffered} · in transit {row.inTransit} · received {row.quantityReceived}
              </p>
              <p className="mt-1 text-sm">State: {row.state.replaceAll('_', ' ')}</p>
              {row.stale && <p className="mt-2 text-sm">Out of date: refresh.</p>}
              {row.declineReason && <p className="mt-2 text-sm">Volunteer declined: {row.declineReason}</p>}
              <div className="mt-3 flex flex-wrap gap-2">
                {mineIsSource && row.state === 'requested' && water && (
                  <button
                    type="button"
                    className={primaryButton}
                    disabled={!connection || pending !== ''}
                    onClick={() =>
                      void call(row.transferId.toString(), (current) =>
                        current.reducers.offerTransfer({
                          transferId: row.transferId,
                          resourceId: water.resourceId,
                          quantity: Math.min(row.quantityRequested, water.available),
                          actionId: crypto.randomUUID(),
                        }),
                      )
                    }
                  >
                    Offer {Math.min(row.quantityRequested, water.available)}
                  </button>
                )}
                {(row.state === 'offered' || row.state === 'approved_reserved') && (
                  <button
                    type="button"
                    className={primaryButton}
                    disabled={!connection || pending !== '' || row.stale}
                    onClick={() =>
                      void call(`approve-${row.transferId}`, (current) =>
                        current.reducers.approveTransfer({ transferId: row.transferId, actionId: crypto.randomUUID() }),
                      )
                    }
                  >
                    Approve our side
                  </button>
                )}
                {mineIsSource && row.state === 'approved_reserved' && carriers[0] && (
                  <button
                    type="button"
                    className={primaryButton}
                    disabled={!connection || pending !== ''}
                    onClick={() =>
                      void call(`task-${row.transferId}`, (current) =>
                        current.reducers.offerTransferTask({
                          transferId: row.transferId,
                          volunteerIdentity: carriers[0].identity,
                          actionId: crypto.randomUUID(),
                        }),
                      )
                    }
                  >
                    Offer pickup to {carriers[0].label}
                  </button>
                )}
                {mineIsSource && row.state === 'approved_reserved' && (
                  <button
                    type="button"
                    className={primaryButton}
                    disabled={!connection || pending !== ''}
                    onClick={() =>
                      void call(`collect-${row.transferId}`, (current) =>
                        current.reducers.collectTransfer({ transferId: row.transferId, actionId: crypto.randomUUID() }),
                      )
                    }
                  >
                    Mark collected
                  </button>
                )}
                {!mineIsSource && row.state === 'in_transit' && (
                  <button
                    type="button"
                    className={primaryButton}
                    disabled={!connection || pending !== ''}
                    onClick={() =>
                      void call(`receive-${row.transferId}`, (current) =>
                        current.reducers.receiveTransfer({
                          transferId: row.transferId,
                          count: row.inTransit,
                          receiptId: crypto.randomUUID(),
                        }),
                      )
                    }
                  >
                    Mark received {row.inTransit}
                  </button>
                )}
                {row.state !== 'in_transit' && row.state !== 'received' && row.state !== 'cancelled' && row.state !== 'lost_adjusted' && (
                  <button
                    type="button"
                    className="inline-flex min-h-12 items-center px-4 text-sm text-muted"
                    disabled={!connection || pending !== ''}
                    onClick={() =>
                      void call(`cancel-${row.transferId}`, (current) =>
                        current.reducers.cancelTransfer({ transferId: row.transferId, actionId: crypto.randomUUID() }),
                      )
                    }
                  >
                    Cancel
                  </button>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
