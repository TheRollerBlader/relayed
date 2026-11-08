import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { primaryButton } from '../components/Dialog'
import { BoltIcon, DropIcon } from '../components/Icons'
import { requestWords } from '../lib/copy'
import { saveRequest } from '../lib/outboxClient'
import { setDeviceOffline, useSession } from '../lib/session'

type Kind = 'water' | 'charging'

function freshStamp() {
  return { iso: new Date().toISOString(), ms: Date.now() }
}

export function RequestView() {
  const session = useSession()
  const navigate = useNavigate()
  const summary = useRef<HTMLDivElement>(null)
  const [kind, setKind] = useState<Kind | null>(null)
  const [accessible, setAccessible] = useState(false)
  const [quantity, setQuantity] = useState('1')
  const [review, setReview] = useState(false)
  const [errors, setErrors] = useState<string[]>([])
  const [sending, setSending] = useState(false)

  useEffect(() => {
    if (errors.length > 0) summary.current?.focus()
  }, [errors])

  function validate(): number | null {
    if (!kind) {
      setErrors(['Choose water or charging.'])
      return null
    }
    if (kind === 'water') {
      if (!/^[1-9]\d*$/.test(quantity) || Number(quantity) > 20) {
        setErrors(['Enter a whole number of water from 1 to 20.'])
        return null
      }
      return Number(quantity)
    }
    return 1
  }

  function continueToReview() {
    if (validate() === null) return
    setErrors([])
    setReview(true)
  }

  async function send() {
    const amount = validate()
    if (amount === null || !kind) return
    setSending(true)
    const clientRequestId = crypto.randomUUID()
    const created = freshStamp()
    await saveRequest({
      clientRequestId,
      shelterId: session.shelterId,
      kind,
      needs: kind === 'charging' && accessible ? ['accessible_slot'] : [],
      quantity: amount,
      clientCreatedAt: created.iso,
      savedAtMs: created.ms,
    })
    navigate(`/r/requests/${clientRequestId}`)
  }

  const ask =
    kind === null
      ? ''
      : requestWords(kind, kind === 'charging' && accessible ? 'accessible_slot' : '', kind === 'water' ? Number(quantity) || 0 : 1)

  return (
    <div className="max-w-xl">
      <p className="font-mono text-[11px] tracking-[0.18em] text-accent">RESIDENT</p>
      <h1 className="mt-3 text-4xl font-medium tracking-tight">Ask for help</h1>
      <p className="mt-3 text-muted">You are Jordan Hale. The receipt moves only after each step has happened.</p>

      <div className="mt-8 border border-line bg-panel p-4">
        <p className="font-mono text-[11px] tracking-[0.16em] text-faint">THIS DEVICE</p>
        <div role="group" aria-label="Device connection" className="mt-3 grid grid-cols-2 gap-2">
          <button type="button" aria-pressed={!session.deviceOffline} onClick={() => setDeviceOffline(false)} className={session.deviceOffline ? quietChoice : activeChoice}>
            Online
          </button>
          <button type="button" aria-pressed={session.deviceOffline} onClick={() => setDeviceOffline(true)} className={session.deviceOffline ? activeChoice : quietChoice}>
            Offline
          </button>
        </div>
        <p aria-live="polite" className="mt-3 text-sm text-muted">
          {session.deviceOffline
            ? 'The desk cannot receive a request from this device.'
            : 'The desk can receive a request from this device.'}
        </p>
      </div>

      {errors.length > 0 && (
        <div ref={summary} tabIndex={-1} role="alert" className="mt-4 border border-line bg-panel px-4 py-3">
          <p className="font-mono text-[11px] tracking-[0.16em] text-accent">CHECK THIS</p>
          <ul className="mt-2 list-disc pl-5 text-sm">
            {errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </div>
      )}

      {review && kind ? (
        <div className="mt-6 border border-line bg-panel p-5">
          <h2 className="text-lg font-medium">You're asking for: {ask}</h2>
          <div className="mt-5 flex flex-wrap gap-3">
            <button type="button" disabled={sending} onClick={() => void send()} className={primaryButton}>
              {sending ? 'Sending…' : 'Send'}
            </button>
            <button type="button" disabled={sending} onClick={() => setReview(false)} className="inline-flex min-h-12 items-center px-4 text-sm text-muted">
              Go back
            </button>
          </div>
        </div>
      ) : (
        <>
          {kind === 'charging' && (
            <label className="mt-4 flex min-h-14 items-center gap-4 border border-line bg-panel px-4 py-3">
              <input type="checkbox" checked={accessible} onChange={(event) => setAccessible(event.target.checked)} className="size-5 accent-accent" />
              <span>
                <span className="block">I need an accessible charging spot</span>
                <span className="block text-sm text-muted">Only tell us what you need to use the spot. Don't include health details.</span>
              </span>
            </label>
          )}
          {kind === 'water' && (
            <label className="mt-4 block text-sm">
              Quantity, from 1 to 20
              <input
                inputMode="numeric"
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
                className="mt-2 block min-h-12 w-full border border-line bg-panel px-3"
              />
            </label>
          )}
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <button type="button" onClick={() => setKind('water')} className={kind === 'water' ? chosen : action}>
              <DropIcon />
              <span className="mt-6 block text-2xl font-medium">Water</span>
            </button>
            <button type="button" onClick={() => setKind('charging')} className={kind === 'charging' ? chosen : action}>
              <BoltIcon />
              <span className="mt-6 block text-2xl font-medium">Charging</span>
            </button>
          </div>
          <button type="button" onClick={continueToReview} className={`${primaryButton} mt-4`}>
            Review
          </button>
        </>
      )}
    </div>
  )
}

const action = 'flex min-h-36 flex-col items-start border border-line bg-panel px-5 py-5 text-left hover:border-accent'
const chosen = `${action} border-accent`
const activeChoice = 'min-h-12 border border-accent text-sm text-accent'
const quietChoice = 'min-h-12 border border-line text-sm text-muted'
