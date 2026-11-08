import { useEffect } from 'react'
import { useAuth } from 'react-oidc-context'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { demoMode, homeFor, spacetimeEnabled } from '../lib/config'
import { formatWhen } from '../lib/copy'
import { stopSharing } from '../lib/liveLocation'
import { bindOutbox, clearDeviceOutboxes, lockOutbox } from '../lib/outboxClient'
import { tables } from '../module_bindings/index.ts'
import { canUseServer, clearDeviceStorage, setDemoRole, setOwner, setShelter, useSession } from '../lib/session'
import { useRows } from '../lib/tables'

const LINKS = {
  resident: [
    { to: '/r/request', label: 'Request' },
    { to: '/r/requests', label: 'Receipts' },
  ],
  coordinator: [
    { to: '/c/queue', label: 'Queue' },
    { to: '/c/board', label: 'Board' },
    { to: '/c/aid', label: 'Aid' },
    { to: '/c/resources', label: 'Resources' },
    { to: '/c/plans', label: 'Plans' },
    { to: '/c/timeline', label: 'Timeline' },
  ],
  volunteer: [{ to: '/v/tasks', label: 'Tasks' }],
} as const

export function Shell() {
  const isHome = useLocation().pathname === '/'
  const session = useSession()
  const [membership, membershipReady] = useRows(tables.myMembership)
  const mine = membership[0]
  useEffect(() => {
    if (!spacetimeEnabled || !membershipReady) return
    if (!mine?.active) {
      if (session.role) setDemoRole(null)
      return
    }
    if ((mine.role === 'resident' || mine.role === 'coordinator' || mine.role === 'volunteer') && session.role !== mine.role) {
      setDemoRole(mine.role)
    }
    if ((mine.shelterId === 'shelter-a' || mine.shelterId === 'shelter-b') && session.shelterId !== mine.shelterId) {
      setShelter(mine.shelterId)
    }
    if (session.ownerIdentity && (mine.shelterId === 'shelter-a' || mine.shelterId === 'shelter-b')) {
      void bindOutbox(session.ownerIdentity, mine.shelterId)
    }
  }, [membershipReady, mine?.active, mine?.role, mine?.shelterId, session.ownerIdentity, session.role, session.shelterId, spacetimeEnabled])
  const links = session.role ? LINKS[session.role] : []
  const connected = canUseServer(session)
  const status = !spacetimeEnabled
    ? 'Offline until deploy'
    : session.deviceOffline
    ? 'Offline'
    : session.link === 'connecting'
      ? 'Connecting to the shelter system…'
      : session.link === 'reconnecting'
        ? 'Reconnecting…'
        : session.link === 'offline'
          ? 'Offline'
          : 'Online'

  return (
    <div className="min-h-screen">
      <a href="#main" className="skip-link">
        Skip to main content
      </a>
      <header className="border-b border-line">
        <div className="shelter-bar mx-auto flex max-w-6xl flex-wrap items-center gap-x-8 gap-y-3 px-5 py-4 sm:px-8">
          <div className="flex items-center gap-3">
            <div>

              <p className="text-lg font-medium leading-none">RelayAid</p>
            </div>
          </div>
          <nav hidden={isHome} aria-label="Views" className="flex flex-wrap gap-5">
            <NavLink to={session.role ? homeFor(session.role) : '/'} className={navClass}>
              Desk
            </NavLink>
            {links.map((link) => (
              <NavLink key={link.to} to={link.to} className={navClass}>
                {link.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-5">
            {isHome ? <a href="#choose-desk" className="text-sm text-muted hover:text-ink">Get started ↗</a> : <>
            <p className="inline-flex min-h-12 items-center gap-2 font-mono text-xs text-ink">
              <span
                aria-hidden="true"
                className={connected ? 'size-2 bg-accent' : 'size-2 border border-ink bg-transparent'}
              />
              <span>
                {status}
                <span className="mt-0.5 block text-faint">Last update {formatWhen(session.lastUpdate)}</span>
              </span>
            </p>
            {demoMode ? (
              <button type="button" onClick={() => void clearDevice()} className="inline-flex min-h-12 items-center font-mono text-xs text-muted hover:text-ink">
                Clear this device
              </button>
            ) : (
              <SignOutButton />
            )}
            </>}
          </div>
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-6xl px-5 py-10 sm:px-8">
        <Outlet />
      </main>
      <footer className="signal-footer">RelayAid <span>Care starts with connection.</span></footer>
    </div>
  )
}

function navClass({ isActive }: { isActive: boolean }) {
  return `inline-flex min-h-12 items-center border-b-2 text-sm ${
    isActive ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink'
  }`
}

function SignOutButton() {
  const auth = useAuth()
  return (
    <button
      type="button"
      className="inline-flex min-h-12 items-center font-mono text-xs text-muted hover:text-ink"
      onClick={() => {
        stopSharing()
        lockOutbox()
        setOwner('')
        setDemoRole(null)
        clearDeviceStorage()
        void auth.signoutRedirect()
      }}
    >
      Sign out
    </button>
  )
}

async function clearDevice() {
  await clearDeviceOutboxes()
  clearDeviceStorage()
  window.location.assign('/')
}
