import { useState } from 'react'
import { Dialog, primaryButton } from '../components/Dialog'
import { ErrorBanner } from '../components/ErrorBanner'
import { resourceWords } from '../lib/copy'
import { tables } from '../module_bindings/index.ts'
import { runReducer, useConnection } from '../lib/server'
import { useRows } from '../lib/tables'

export function ResourcesView() {
  const connection = useConnection()
  const [rows] = useRows(tables.coordinatorResources)
  const [plans] = useRows(tables.coordinatorPlans)
  const [estimates] = useRows(tables.coordinatorEstimates)
  const [error, setError] = useState<string | null>(null)
  const [pendingId, setPendingId] = useState('')
  const [drafts, setDrafts] = useState<Record<string, { total: string; available: string }>>({})
  const [confirm, setConfirm] = useState<null | { id: string; drop: number; reserved: number; name: string }>(null)
  const openPlans = plans.some((plan) => plan.status === 'proposed')

  function draftFor(id: string, total: number, available: number) {
    return drafts[id] ?? { total: String(total), available: String(available) }
  }

  async function save(id: string, version: bigint, total: number, available: number) {
    setPendingId(id)
    setError(null)
    const result = await runReducer(connection, (current) =>
      current.reducers.updateResource({
        resourceId: id,
        expectedVersion: version,
        capacityTotal: total,
        available,
      }),
    )
    setPendingId('')
    if (!result.ok) setError(result.text)
  }

  function askSave(id: string, version: bigint, currentAvailable: number, reserved: number, name: string) {
    const draft = drafts[id]
    if (!draft) return
    if (!/^\d+$/.test(draft.total) || !/^\d+$/.test(draft.available)) {
      setError('Use whole numbers.')
      return
    }
    const total = Number(draft.total)
    const available = Number(draft.available)
    if (available < currentAvailable) {
      setConfirm({ id, drop: currentAvailable - available, reserved, name })
      return
    }
    void save(id, version, total, available)
  }

  return (
    <div>
      <p className="font-mono text-[11px] tracking-[0.18em] text-accent">COORDINATOR</p>
      <h1 className="mt-3 text-4xl font-medium tracking-tight">Resources</h1>
      <p className="mt-3 max-w-2xl text-muted">These numbers come from the shelter system. A change makes open plans out of date.</p>
      {openPlans && <p className="mt-4 text-sm text-muted">Open plans will be marked out of date after you save.</p>}
      {error && (
        <div className="mt-4 max-w-xl">
          <ErrorBanner title="Not saved" text={error} />
        </div>
      )}
      <section className="mt-6 border border-line bg-panel p-4">
        <h2 className="font-mono text-[11px] tracking-[0.16em] text-faint">SHORTAGE ESTIMATE</h2>
        <ul className="mt-3 space-y-2 text-sm">
          {estimates.map((item) => (
            <li key={item.estimateId}>
              {item.resourceKind === 'water_stock' ? 'Water' : 'Charging'} · sample {item.sampleSize} · {item.label}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-sm text-muted">Residents are not shown an arrival time. Adding a volunteer does not create stock.</p>
      </section>
      <ul className="mt-6 grid gap-4">
        {rows.map((row) => {
          const draft = draftFor(row.resourceId, row.capacityTotal, row.available)
          const name = resourceWords(row.kind, row.accessible)
          return (
            <li key={row.resourceId} className="border border-line bg-panel p-4">
              <h2 className="text-lg font-medium">{name}</h2>
              <p className="mt-1 font-mono text-xs text-faint">
                Total {row.capacityTotal} · Available {row.available} · {row.kind === 'water_stock' ? 'Reserved' : 'In use'} {row.reserved}
              </p>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <label className="text-sm">
                  Total
                  <input
                    inputMode="numeric"
                    value={draft.total}
                    onChange={(event) =>
                      setDrafts((current) => ({ ...current, [row.resourceId]: { ...draft, total: event.target.value } }))
                    }
                    className="mt-1 block min-h-12 w-full border border-line bg-canvas px-3"
                  />
                </label>
                <label className="text-sm">
                  Available
                  <input
                    inputMode="numeric"
                    value={draft.available}
                    onChange={(event) =>
                      setDrafts((current) => ({ ...current, [row.resourceId]: { ...draft, available: event.target.value } }))
                    }
                    className="mt-1 block min-h-12 w-full border border-line bg-canvas px-3"
                  />
                </label>
              </div>
              <button
                type="button"
                disabled={!connection || pendingId === row.resourceId}
                onClick={() => askSave(row.resourceId, row.version, row.available, row.reserved, name)}
                className={`${primaryButton} mt-4`}
              >
                {pendingId === row.resourceId ? 'Saving…' : 'Save'}
              </button>
            </li>
          )
        })}
      </ul>
      {confirm && (
        <Dialog
          title={`Reduce ${confirm.name.toLowerCase()} by ${confirm.drop}?`}
          body={`${confirm.reserved} are reserved and stay reserved.`}
          confirmLabel="Reduce"
          onConfirm={() => {
            const row = rows.find((item) => item.resourceId === confirm.id)
            const draft = drafts[confirm.id]
            setConfirm(null)
            if (!row || !draft) return
            void save(row.resourceId, row.version, Number(draft.total), Number(draft.available))
          }}
          onClose={() => setConfirm(null)}
        />
      )}
    </div>
  )
}
