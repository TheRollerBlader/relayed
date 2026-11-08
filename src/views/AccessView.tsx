import { Link } from 'react-router-dom'
import { clearAccessReason, useSession } from '../lib/session'

export function AccessView() {
  const session = useSession()
  const text =
    session.accessReason ??
    (session.role
      ? `This browser is the ${session.role}. Open another browser profile for a different role.`
      : "This device isn't set up for this shelter. Ask staff.")

  return (
    <div className="max-w-xl">
      <p className="font-mono text-[11px] tracking-[0.18em] text-accent">ACCESS</p>
      <h1 className="mt-3 text-4xl font-medium tracking-tight">This desk can't open that</h1>
      <p className="mt-4 text-muted">{text}</p>
      <p className="mt-3 text-sm text-faint">Unsent resident requests stay on this device.</p>
      <Link
        to="/"
        onClick={() => clearAccessReason()}
        className="mt-6 inline-flex min-h-12 items-center text-accent"
      >
        Back to the desk
      </Link>
    </div>
  )
}
