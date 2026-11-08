import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { primaryButton } from '../components/Dialog'
import { tables } from '../module_bindings/index.ts'
import { runReducer, useConnection } from '../lib/server'
import { useSession } from '../lib/session'
import { useRows } from '../lib/tables'

export function InvitePanel() {
  const session = useSession()
  const connection = useConnection()
  const [invites] = useRows(tables.coordinatorInvites)
  const [role, setRole] = useState<'resident' | 'volunteer'>('resident')
  const [inviteId, setInviteId] = useState('')
  const [svg, setSvg] = useState('')
  const [error, setError] = useState<string | null>(null)
  const link = inviteId ? `${window.location.origin}/join/${inviteId}` : ''

  useEffect(() => {
    if (!link) return
    void QRCode.toString(link, { type: 'svg', margin: 1, width: 168 }).then(setSvg)
  }, [link])

  async function create() {
    const id = crypto.randomUUID()
    setError(null)
    const result = await runReducer(connection, (current) =>
      current.reducers.createInvite({
        inviteId: id,
        shelterId: session.shelterId,
        role,
        taskId: '',
        expiresAtMicros: BigInt(Date.now()) * 1000n + 7_200_000_000n,
        maxUses: 1,
      }),
    )
    if (!result.ok) {
      setError(result.text)
      return
    }
    setInviteId(id)
  }

  const saved = invites.find((row) => row.inviteId === inviteId)

  return (
    <section className="mt-10 border border-line bg-panel p-4">
      <h2 className="font-mono text-[11px] tracking-[0.16em] text-faint">INVITE</h2>
      <p className="mt-2 text-sm text-muted">The link only contains the invite id. The phone signs in, then the shelter checks the invite.</p>
      <div className="mt-4 flex flex-wrap gap-3">
        <label className="text-sm">
          Role
          <select value={role} onChange={(event) => setRole(event.target.value === 'volunteer' ? 'volunteer' : 'resident')} className="mt-2 block min-h-12 border border-line bg-panel px-3">
            <option value="resident">Resident</option>
            <option value="volunteer">Volunteer</option>
          </select>
        </label>
        <button type="button" className={primaryButton} disabled={!connection} onClick={() => void create()}>
          Create invite
        </button>
      </div>
      {error && <p className="mt-3 text-sm">{error}</p>}
      {link && (
        <div className="mt-4">
          <p className="break-all text-sm">{link}</p>
          {saved && <p className="mt-2 text-sm text-muted">Uses {saved.useCount.toString()} of {saved.maxUses.toString()}.</p>}
          {svg && <div className="mt-3 w-44" dangerouslySetInnerHTML={{ __html: svg }} />}
        </div>
      )}
    </section>
  )
}
