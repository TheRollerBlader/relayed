import type { BadgeKind } from '../lib/copy'

type IconProps = {
  className?: string
}

export function StatusIcon({ status, className = 'size-4' }: { status: BadgeKind; className?: string }) {
  const common = {
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    className,
  }

  if (status === 'saved') {
    return (
      <svg {...common}>
        <rect x="4" y="2" width="8" height="12" rx="1" />
        <path d="M7 11.5h2" />
      </svg>
    )
  }

  if (status === 'sending' || status === 'delivered') {
    return (
      <svg {...common}>
        <path d="M2 8h9" />
        <path d="M8 5l4 3-4 3" />
      </svg>
    )
  }

  if (status === 'seen') {
    return (
      <svg {...common}>
        <path d="M1.5 8S4 4 8 4s6.5 4 6.5 4-2.5 4-6.5 4S1.5 8 1.5 8z" />
        <circle cx="8" cy="8" r="1.5" />
      </svg>
    )
  }

  if (status === 'assigned' || status === 'reserved' || status === 'todo' || status === 'offered' || status === 'review') {
    return (
      <svg {...common}>
        <path d="M8 2v7" />
        <path d="M5 7l3 3 3-3" />
        <path d="M3.5 13.5h9" />
      </svg>
    )
  }

  if (status === 'cancelled' || status === 'rejected' || status === 'expired') {
    return (
      <svg {...common}>
        <path d="M4 4l8 8M12 4 4 12" />
      </svg>
    )
  }

  return (
    <svg {...common}>
      <path d="M3 8.5 6.2 12 13 4" />
    </svg>
  )
}

export function DropIcon({ className = 'size-7' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className} aria-hidden="true">
      <path d="M12 3s6 6.2 6 10.2A6 6 0 0 1 6 13.2C6 9.2 12 3 12 3z" />
    </svg>
  )
}

export function BoltIcon({ className = 'size-7' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className} aria-hidden="true">
      <path d="M13 2 4 14h8l-1 8 9-12h-8l1-8z" />
    </svg>
  )
}
