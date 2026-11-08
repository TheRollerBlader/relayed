import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Room, RoomEvent } from 'livekit-client'
import { api } from '../lib/gateway.ts'
import { useResponse } from './context.tsx'

function deviceId() {
  let id = sessionStorage.getItem('relayaid-device')
  if (!id) {
    id = crypto.randomUUID()
    sessionStorage.setItem('relayaid-device', id)
  }
  return id
}

type Heard = { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }
type Listener = {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((event: Heard) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
}

function listener(): Listener | null {
  const root = window as Window & {
    SpeechRecognition?: new () => Listener
    webkitSpeechRecognition?: new () => Listener
  }
  const Kind = root.SpeechRecognition || root.webkitSpeechRecognition
  return Kind ? new Kind() : null
}

function speak(text: string) {
  window.speechSynthesis?.cancel()
  return new Promise<void>((resolve) => {
    if (!window.speechSynthesis) {
      resolve()
      return
    }
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.onend = () => resolve()
    utterance.onerror = () => resolve()
    window.speechSynthesis.speak(utterance)
  })
}

export function CallPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const { view, mutate, refresh, language } = useResponse()
  const roomRef = useRef<Room | null>(null)
  const earRef = useRef<Listener | null>(null)
  const [joined, setJoined] = useState(false)
  const [textMode, setTextMode] = useState(false)
  const [listening, setListening] = useState(false)
  const [voiceReady, setVoiceReady] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [muted, setMuted] = useState(false)
  const [frameNote, setFrameNote] = useState('')
  const call = view?.calls.find((item) => item.id === id)
  const mine = call && view?.profile.id === call.ownerId
  const allows = (type: string) => view?.consents.some((item) => item.type === type && item.granted && (item.caseId === call?.caseId || item.caseId === '*'))
  const micAllowed = allows('microphone')
  const canLook = allows('camera') && allows('vision')

  function stopVoice() {
    earRef.current?.stop()
    earRef.current = null
    window.speechSynthesis?.cancel()
    setListening(false)
  }

  async function say(text: string) {
    const result = await api<{ caption: string }>('/api/talk', { callId: call?.id, text })
    await refresh()
    await speak(result.caption)
  }

  function listen() {
    if (!micAllowed) {
      setError('Turn on the microphone for this case, then try the call again.')
      return
    }
    const ear = listener()
    if (!ear) {
      setError('This browser cannot use the microphone for speech. Type instead.')
      return
    }
    stopVoice()
    ear.lang = language === 'es' ? 'es-ES' : 'en-US'
    ear.continuous = false
    ear.interimResults = false
    ear.onresult = (event) => {
      const heard = event.results[event.resultIndex]?.[0]?.transcript?.trim()
      if (!heard) return
      setBusy(true)
      void say(heard)
        .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : 'The reply did not finish.'))
        .finally(() => setBusy(false))
    }
    ear.onerror = (event) => {
      setListening(false)
      if (event.error !== 'aborted' && event.error !== 'no-speech') setError('The microphone did not catch that. Try again or type.')
    }
    ear.onend = () => setListening(false)
    earRef.current = ear
    setError('')
    setListening(true)
    ear.start()
  }

  async function leave(endOnServer: boolean) {
    stopVoice()
    const room = roomRef.current
    roomRef.current = null
    if (room) {
      await room.localParticipant.setMicrophoneEnabled(false).catch(() => undefined)
      await room.localParticipant.setCameraEnabled(false).catch(() => undefined)
      room.disconnect()
    }
    setJoined(false)
    if (endOnServer && call && mine) {
      await mutate('end_call', { callId: call.id, deviceId: deviceId() }, call.caseId, view?.cases.find((item) => item.id === call.caseId)?.version)
    }
  }

  useEffect(() => {
    const stop = () => {
      void leave(false)
    }
    window.addEventListener('relayaid-stop-media', stop)
    const withdrawn = (event: Event) => {
      const type = (event as CustomEvent<string>).detail
      if (type === 'microphone' || type === 'camera') void leave(true)
    }
    window.addEventListener('relayaid-consent-withdrawn', withdrawn)
    return () => {
      window.removeEventListener('relayaid-stop-media', stop)
      window.removeEventListener('relayaid-consent-withdrawn', withdrawn)
      void leave(false)
    }
  }, [id])

  async function join() {
    if (!call || !mine) return
    setBusy(true)
    setError('')
    try {
      const device = deviceId()
      if (call.state === 'connecting' || call.state === 'ringing') {
        await mutate('answer_call', { callId: call.id, deviceId: device }, call.caseId)
      }
      const media = await api<{ mode?: string; token?: string; url?: string; recording: boolean }>('/api/media/token', {
        callId: call.id,
        deviceId: device,
      })
      if (media.recording) throw new Error('This demo does not record calls.')
      if (media.mode === 'text' || !media.url || !media.token) {
        setTextMode(true)
        setVoiceReady(Boolean(listener()))
        setJoined(true)
        return
      }
      const room = new Room()
      roomRef.current = room
      room.on(RoomEvent.Disconnected, () => setJoined(false))
      await room.connect(media.url, media.token)
      await room.localParticipant.setMicrophoneEnabled(true)
      setJoined(true)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The call did not connect.')
      await leave(false)
    } finally {
      setBusy(false)
    }
  }

  if (!call || !mine) {
    return (
      <p>
        That call is not on this device. <Link to="/">Back to your cases</Link>
      </p>
    )
  }

  return (
    <div>
      <p className="eyebrow">AI ASSISTANT · NOT A PERSON</p>
      <h1>Talk to RelayAid</h1>
      <p className="muted">This is a spoken conversation with an automated assistant on this device. It uses your microphone and speaker. It is not a phone-network call, it is not recorded, and ending it does not close your case.</p>
      <p>Status: {call.state.replaceAll('_', ' ')}</p>
      {error && <p role="alert">{error}</p>}
      {!textMode && !micAllowed && <p>Microphone consent is off. You can still use text. Turn the microphone on from the case page before a voice call.</p>}
      <div className="button-row">
        {!joined && (
          <button type="button" className="primary" disabled={busy || call.state === 'ended' || call.state === 'failed'} onClick={() => void join()}>
            {busy ? 'Joining…' : 'Join call'}
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void leave(true).then(() => navigate(`/cases/${call.caseId}`))
          }}
        >
          End call
        </button>
        <button type="button" onClick={() => { window.speechSynthesis?.cancel(); earRef.current?.stop(); setListening(false) }}>
          Interrupt
        </button>
        <button
          type="button"
          onClick={() => {
            const room = roomRef.current
            if (!room) {
              setTextMode(true)
              return
            }
            const next = !muted
            void room.localParticipant.setMicrophoneEnabled(!next).then(() => setMuted(next))
          }}
        >
          {muted ? 'Unmute' : 'Mute'}
        </button>
        <button type="button" onClick={() => setTextMode(true)}>
          Switch to text
        </button>
        <button
          type="button"
          disabled={!canLook || busy}
          onClick={() => {
            void (async () => {
              if (!canLook || !call) return
              setBusy(true)
              setError('')
              let stream: MediaStream | null = null
              try {
                stream = await navigator.mediaDevices.getUserMedia({ video: true })
                const video = document.createElement('video')
                video.srcObject = stream
                await video.play()
                const canvas = document.createElement('canvas')
                canvas.width = 320
                canvas.height = 180
                canvas.getContext('2d')?.drawImage(video, 0, 0, 320, 180)
                const image = canvas.toDataURL('image/jpeg', 0.7)
                const result = await api<{ observation?: string }>('/api/media/frame', { callId: call.id, image })
                const observation = result.observation || 'Camera analysis is not configured. Describe the scene in text.'
                setFrameNote(observation.toLowerCase().startsWith('possibly') ? observation : `Possibly: ${observation}`)
              } catch {
                setError('The still frame was not shared. You can describe the scene in text.')
              } finally {
                stream?.getTracks().forEach((track) => track.stop())
                setBusy(false)
              }
            })()
          }}
        >
          Share one still frame
        </button>
        <Link className="button" to={`/cases/${call.caseId}`}>
          Back to the case
        </Link>
      </div>
      {textMode && voiceReady && (
        <button type="button" className="primary" disabled={busy || listening || call.state === 'ended'} onClick={listen}>
          {listening ? 'Listening…' : 'Talk'}
        </button>
      )}
      {textMode && (
        <form
          className="report-form"
          onSubmit={(event) => {
            event.preventDefault()
            const text = draft.trim()
            if (!text) return
            setDraft('')
            setBusy(true)
            void api('/api/talk', { callId: call.id, text })
              .then(() => refresh())
              .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : 'The message was not sent.'))
              .finally(() => setBusy(false))
          }}
        >
          <label>
            Message
            <textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={3} maxLength={2000} />
          </label>
          <button className="primary" disabled={busy || !draft.trim()}>
            Send
          </button>
        </form>
      )}
      {canLook && <p>The assistant is looking at a still frame only when you tap the button. No person is watching. Nothing is marked AI verified.</p>}
      {frameNote && <p className="notice" role="status">{frameNote}</p>}
      <section className="panel" aria-live="polite">
        <h2>Captions</h2>
        {call.transcript.length === 0 && <p className="muted">Nothing has been said yet.</p>}
        <ol className="captions">
          {call.transcript.map((line, index) => (
            <li key={`${line.at}-${index}`}>
              <strong>{line.role === 'assistant' ? 'RelayAid assistant' : 'You'}</strong>
              <p>{line.text}</p>
            </li>
          ))}
        </ol>
      </section>
    </div>
  )
}
