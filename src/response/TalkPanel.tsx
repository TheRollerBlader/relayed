import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/gateway.ts'
type Draft = { category: string; quantity: number; danger: 'yes' | 'no' | 'unsure'; summary: string; accessibleKnown: boolean; accessible: boolean }
import { useResponse } from './context.tsx'

const HALLS = [
  { id: 'shelter-a', label: 'North Hall', lat: 32.9, lon: -96.8 },
  { id: 'shelter-b', label: 'South Hall', lat: 32.7, lon: -96.8 },
] as const

export function TalkPanel() {
  const { language, refresh } = useResponse()
  const navigate = useNavigate()
  const [text, setText] = useState('')
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [label, setLabel] = useState('')
  const [shelterId, setShelterId] = useState<(typeof HALLS)[number]['id']>('shelter-b')
  const [callbacks, setCallbacks] = useState(false)
  const [shareLocation, setShareLocation] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const hall = HALLS.find((item) => item.id === shelterId) || HALLS[1]
  const urgent = drafts.some((draft) => draft.danger !== 'no') || /smoke|fire|trap|flood|hurt|injur/i.test(text)

  async function organize() {
    setBusy(true)
    setError('')
    try {
      const result = await api<{ label: string; drafts: Draft[] }>('/api/intake/analyze', { text, language })
      setLabel(result.label)
      setDrafts(result.drafts)
      if (/south/i.test(text)) setShelterId('shelter-b')
      if (/north/i.test(text)) setShelterId('shelter-a')
    } catch {
      setLabel('AI unavailable. Deterministic readback only.')
    } finally {
      setBusy(false)
    }
  }

  async function confirm() {
    if (drafts.some((draft) => draft.category === 'water' && (draft.quantity < 1 || draft.quantity > 20))) {
      setError('Water is limited to 1–20. Edit the quantity before confirming.')
      return
    }
    setBusy(true)
    setError('')
    try {
      await api('/api/intake/confirm', {
        conversationId: crypto.randomUUID().replaceAll('-', '').slice(0, 24),
        text,
        shelterId,
        affectedPerson: drafts.some((draft) => draft.category === 'rescue' || draft.category === 'fire') ? 'someone_else' : 'myself',
        callbacks,
        shareLocation,
        location: {
          label: hall.label,
          source: 'landmark',
          lat: hall.lat,
          lon: hall.lon,
          accuracyM: 30,
          capturedAt: Date.now(),
          confirmed: true,
        },
        drafts,
      })
      await refresh()
      navigate('/')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The report was not saved.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="report-layout">
      <div>
        <p className="eyebrow">AI ASSISTANT · NOT A PERSON</p>
        <h1>{language === 'es' ? 'Habla con RelayAid' : 'Talk to RelayAid'}</h1>
        <p className="muted">The assistant reads your words back. It does not diagnose, promise an arrival, or call 911 for you.</p>
        {urgent && (
          <div className="urgent-notice">
            Call <a href="tel:911">911</a> if anyone is in danger. RelayAid has not dispatched emergency services.
          </div>
        )}
        <form
          className="report-form"
          onSubmit={(event) => {
            event.preventDefault()
            if (drafts.length) void confirm()
            else void organize()
          }}
        >
          <label>
            What should the assistant hear?
            <textarea rows={4} maxLength={2000} value={text} onChange={(event) => { setText(event.target.value); setDrafts([]) }} placeholder="We need water for four people at South Hall, and my neighbor is trapped by water." />
          </label>
          <div className="button-row">
            <button type="button" disabled={!text.trim() || busy} onClick={() => void organize()}>{busy ? 'Listening…' : 'Read it back'}</button>
            <button type="button" onClick={() => window.speechSynthesis?.cancel()}>Interrupt</button>
          </div>
          {label && <p className="notice" role="status">{label}</p>}
          {drafts.length > 0 && (
            <div>
              <p><b>I heard: {drafts.map((draft) => draft.summary).join('; ')}. Correct?</b></p>
              {drafts.map((draft, index) => (
                <div className="admin-row" key={`${draft.category}-${index}`}>
                  <span>{draft.summary}</span>
                  {draft.category === 'water' && (
                    <input aria-label={`Quantity for ${draft.summary}`} type="number" min={1} max={20} value={draft.quantity} onChange={(event) => setDrafts((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, quantity: Number(event.target.value) } : row))} />
                  )}
                  {draft.category === 'charging' && (
                    <select aria-label="Charger type" value={draft.accessibleKnown ? (draft.accessible ? 'accessible' : 'standard') : 'unset'} onChange={(event) => setDrafts((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, accessibleKnown: event.target.value !== 'unset', accessible: event.target.value === 'accessible' } : row))}>
                      <option value="unset">Ask me later</option>
                      <option value="standard">Standard</option>
                      <option value="accessible">Accessible</option>
                    </select>
                  )}
                </div>
              ))}
              <label>
                Hall landmark
                <select value={shelterId} onChange={(event) => setShelterId(event.target.value as typeof shelterId)}>
                  {HALLS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                </select>
              </label>
              <p className="muted">Landmark accuracy ±30 m · captured just now. This is the hall you picked, not a guessed street route.</p>
              <label className="check-row">
                <input type="checkbox" checked={shareLocation} onChange={(event) => setShareLocation(event.target.checked)} />
                <span>Share this precise hall landmark with the responding service</span>
              </label>
              <label className="check-row">
                <input type="checkbox" checked={callbacks} onChange={(event) => setCallbacks(event.target.checked)} />
                <span>Let the assistant call you about this request</span>
              </label>
              {error && <p role="alert">{error}</p>}
              <button className="primary" disabled={busy}>Confirm and open the cases</button>
            </div>
          )}
          {!drafts.length && error && <p role="alert">{error}</p>}
        </form>
      </div>
      <aside className="panel">
        <p className="eyebrow">WHAT THIS CALL DOES</p>
        <ol>
          <li>Reads the words back. It does not invent an arrival time.</li>
          <li>Splits safe aid and a rescue into linked cases after you confirm.</li>
          <li>Reserves water only when the hall has it, or requests a hall transfer.</li>
          <li>Sends fire, medical, and rescue only to the synthetic responder sandbox.</li>
        </ol>
      </aside>
    </div>
  )
}
