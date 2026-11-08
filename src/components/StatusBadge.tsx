import { badgeLabel, type BadgeKind } from '../lib/copy'
import { StatusIcon } from './Icons'

export function StatusBadge({ status }: { status: BadgeKind }) {
  return (
    <span className="inline-flex min-h-8 items-center gap-2 border border-line px-2.5 font-mono text-[11px] tracking-wide text-ink">
      <StatusIcon status={status} />
      {badgeLabel(status)}
    </span>
  )
}
