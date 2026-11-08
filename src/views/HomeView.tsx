import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { primaryButton } from '../components/Dialog'
import { ErrorBanner } from '../components/ErrorBanner'
import { demoMode, homeFor, roleLabels, SHELTERS, spacetimeEnabled, type DemoRole, type ShelterId } from '../lib/config'
import { setDemoRole, setShelter, useSession } from '../lib/session'
import { runReducer, useConnection } from '../lib/server'

const ROLES: DemoRole[] = ['resident', 'coordinator', 'volunteer']

export function HomeView() {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const elements = root.current?.querySelectorAll('[data-reveal]')
    if (!elements || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const observer = new IntersectionObserver(entries => entries.forEach(entry => {
      if (entry.isIntersecting) { entry.target.classList.add('is-visible'); observer.unobserve(entry.target) }
    }), { threshold: 0.12 })
    elements.forEach(element => { element.classList.add('reveal-ready'); observer.observe(element) })
    return () => observer.disconnect()
  }, [])
  const session = useSession()
  const connection = useConnection()
  const navigate = useNavigate()
  const [pending, setPending] = useState<DemoRole | null>(null)
  const [hall, setHall] = useState<ShelterId>(session.shelterId)
  const [error, setError] = useState<string | null>(null)

  async function claim(role: DemoRole) {
    setError(null)
    setPending(role)
    setShelter(hall)
    if (!spacetimeEnabled || !connection) {
      setDemoRole(role)
      setPending(null)
      navigate(homeFor(role))
      return
    }
    const result = await runReducer(connection, (current) =>
      current.reducers.claimDemoRole({
        shelterId: hall,
        role,
        displayLabel: roleLabels[role],
      }),
    )
    setPending(null)
    if (!result.ok) {
      setError(result.text)
      if (result.code === 'UNAUTHORIZED' || result.code === 'WRONG_SHELTER') navigate('/access')
      return
    }
    setDemoRole(role)
    navigate(homeFor(role))
  }

  return (
    <div className="signal-home" ref={root}>
    <section className="hero-scene">
    <div className="hero-copy" data-reveal>
      <p className="font-mono text-xs tracking-widest text-accent">CARE, CONNECTED</p>
      <h1 className="signal-title">Different needs.<span>One community.</span></h1>
      <p className="mb-8 text-muted">Connect people with the help they need.</p>
      <a className="hero-action" href="#choose-desk">Find your place <span aria-hidden="true">↗</span></a>
    </div>
    <div className="hero-world" data-reveal><Globe /></div>
    </section>
    <section id="choose-desk" className="desk-section" data-reveal>
      <p className="section-kicker">START HERE</p>
      <div className="mt-4 flex flex-wrap gap-3">
        {SHELTERS.map((item) => (
          <button
            key={item.id}
            type="button"
            disabled={session.role !== null}
            onClick={() => setHall(item.id)}
            className={hall === item.id ? 'min-h-12 border border-accent px-4 text-sm' : 'min-h-12 border border-line px-4 text-sm text-muted'}
          >
            {item.name}
          </button>
        ))}
      </div>
      <h2 className="mt-6 text-2xl font-medium tracking-tight">{demoMode ? 'Choose a desk' : 'Shelter desk'}</h2>
      <p className="mt-3 text-muted">
        {demoMode
          ? 'Choose how you want to help. Demo roles are saved on this device.'
          : 'Use your coordinator’s invite to join your shelter.'}
      </p>
      {session.role && (
        <p className="mt-6 border border-line bg-panel px-4 py-3 text-sm">
          This browser is the {session.role}.{' '}
          <Link to={homeFor(session.role)} className="text-accent">
            Continue
          </Link>
        </p>
      )}
      {error && (
        <div className="mt-6">
          <ErrorBanner title="Not claimed" text={error} />
        </div>
      )}
      {demoMode && (
      <div className="role-options">
        {ROLES.map((role) => (
          <button
            key={role}
            type="button"
            disabled={pending !== null || session.role !== null || (spacetimeEnabled && !connection)}
            onClick={() => void claim(role)}
            className={`${primaryButton} role-option capitalize`}
          >
            {pending === role ? 'Claiming…' : role}
          </button>
        ))}
      </div>
      )}
    </section>
    </div>
  )
}

function Globe() {
  return <svg className="hero-globe" viewBox="0 0 600 600" role="img" aria-label="A wireframe globe connecting communities">
    <defs><radialGradient id="glow"><stop stopColor="#ed66b7" stopOpacity=".12"/><stop offset="1" stopColor="#ed66b7" stopOpacity="0"/></radialGradient><clipPath id="sphere"><circle cx="300" cy="300" r="218"/></clipPath></defs>
    <circle cx="300" cy="300" r="295" fill="url(#glow)"/>
    <g className="globe-drift" transform="rotate(-18 300 300)" fill="none" stroke="#ed66b7">
      <circle cx="300" cy="300" r="218" strokeOpacity=".5"/>
      <g strokeOpacity=".28" strokeWidth=".8">
        {[35,75,115,155,190].map(r=><ellipse key={r} cx="300" cy="300" rx={r} ry="218"/>)}
        <g clipPath="url(#sphere)">{[-180,-135,-90,-45,0,45,90,135,180].map(y=><ellipse key={y} cx="300" cy={300+y} rx="218" ry="38"/>)}</g>
      </g>
      <ellipse cx="300" cy="300" rx="267" ry="86" strokeOpacity=".35" strokeDasharray="2 8"/>
      <path d="M150 210 Q300 45 440 260 M150 210 Q200 380 365 425 M440 260 Q475 370 365 425" strokeOpacity=".8"/>
      {[[150,210],[440,260],[365,425]].map(([x,y])=><g key={x}><circle className="globe-pulse" cx={x} cy={y} r="13" fill="#ed66b7" fillOpacity=".12" stroke="none"/><circle cx={x} cy={y} r="4" fill="#f8a4d6" stroke="none"/></g>)}
    </g>
  </svg>
}
