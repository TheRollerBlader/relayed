export type BadgeKind =
  | 'saved'
  | 'sending'
  | 'delivered'
  | 'seen'
  | 'assigned'
  | 'completed'
  | 'cancelled'
  | 'rejected'
  | 'expired'
  | 'reserved'
  | 'todo'
  | 'done'
  | 'offered'
  | 'review'

export function badgeLabel(kind: BadgeKind): string {
  switch (kind) {
    case 'saved':
      return 'Saved on this device'
    case 'sending':
      return 'Sending'
    case 'delivered':
      return 'Delivered'
    case 'seen':
      return 'Seen by a person'
    case 'assigned':
      return 'Assigned'
    case 'completed':
      return 'Completed'
    case 'cancelled':
      return 'Cancelled'
    case 'rejected':
      return 'Not accepted'
    case 'expired':
      return "Couldn't send"
    case 'reserved':
      return 'Reserved'
    case 'todo':
      return 'To do'
    case 'done':
      return 'Done'
    case 'offered':
      return 'Offered'
    case 'review':
      return 'Needs review'
  }
}

export function serverBadge(state: string): BadgeKind {
  switch (state) {
    case 'acknowledged':
      return 'seen'
    case 'assigned':
      return 'assigned'
    case 'completed':
      return 'completed'
    case 'cancelled':
      return 'cancelled'
    case 'rejected':
      return 'rejected'
    default:
      return 'delivered'
  }
}

export function serverSentence(state: string, reason = ''): string {
  switch (state) {
    case 'acknowledged':
      return 'A staff member has seen your request.'
    case 'assigned':
      return 'Someone has been assigned to help.'
    case 'completed':
      return "Marked as done. If that's wrong, tell staff."
    case 'cancelled':
      return 'This request was cancelled.'
    case 'rejected':
      return reason
        ? `Staff couldn't accept this request: ${reasonWords(reason)}.`
        : "Staff couldn't accept this request."
    default:
      return 'Delivered to the shelter system. No one has looked at it yet.'
  }
}

export function localSentence(notice: string, status: string): string {
  if (notice.startsWith('REFUSED:')) {
    return `The shelter system didn't accept this: ${reasonWords(notice.slice('REFUSED:'.length))}.`
  }
  if (notice === 'CHECKING') return 'Checking whether it arrived…'
  if (notice === 'IDEMPOTENCY_CONFLICT') {
    return "This changed after it was saved and couldn't be sent. Send it as a new request?"
  }
  if (status === 'sending') return 'Trying to send…'
  if (status === 'not_delivered') return 'Not delivered. Please ask staff in person.'
  return "Saved on this device. Not delivered yet. We'll keep trying when you're back online."
}

export function taskBadge(dispatchState: string, state: string): BadgeKind {
  if (dispatchState === 'offered') return 'offered'
  if (dispatchState === 'overdue_review') return 'review'
  if (dispatchState === 'accepted' || dispatchState === 'in_progress') return 'todo'
  if (state === 'delivered' || state === 'completed' || dispatchState === 'delivered') return 'done'
  if (state === 'reserved' || dispatchState === 'unassigned') return 'reserved'
  return 'todo'
}

export function localBadge(status: string, notice: string): BadgeKind {
  if (notice.startsWith('REFUSED:')) return 'rejected'
  if (notice === 'CHECKING' || status === 'sending') return 'sending'
  if (status === 'not_delivered') return 'expired'
  if (status === 'delivered') return 'delivered'
  return 'saved'
}

export function reasonWords(code: string): string {
  switch (code) {
    case 'not_acknowledged':
      return 'Not seen by a person yet'
    case 'no_eligible_resource':
      return 'Needs accessible charging; none free'
    case 'capacity_exhausted':
      return 'No capacity left'
    case 'waiting_for_approval':
      return 'Waiting for a plan'
    case 'assigned':
      return 'Assigned'
    case 'completed':
      return 'Completed'
    case 'cancelled':
      return 'Cancelled'
    case 'rejected':
      return 'Not accepted'
    case 'out_of_scope':
      return 'Out of scope'
    case 'invalid_request':
      return 'Invalid request'
    case 'staff_cancelled':
      return 'Staff cancelled it'
    case 'duplicate':
      return 'Duplicate'
    case 'resident_cancelled':
      return 'You cancelled it'
    default:
      return code.replaceAll('_', ' ')
  }
}

export function errorSentence(code: string): string {
  switch (code) {
    case 'UNAUTHORIZED':
      return "This device isn't set up for this shelter. Ask staff."
    case 'WRONG_SHELTER':
      return "You don't have access to this shelter."
    case 'INVALID_TRANSITION':
      return "This request changed. Here's the latest."
    case 'STALE_PLAN':
      return 'Another change happened first, so nothing was reserved. Regenerate the plan.'
    case 'ALREADY_APPROVED':
      return 'This plan was already approved.'
    case 'INSUFFICIENT_CAPACITY':
      return 'Not enough capacity is left for a resource in this plan.'
    case 'IDEMPOTENCY_CONFLICT':
      return "This changed after it was saved and couldn't be sent. Send it as a new request?"
    case 'INVALID_INPUT':
      return "The shelter system didn't accept this: invalid input."
    case 'STALE_OFFER':
      return 'Out of date: refresh.'
    case 'RATE_LIMIT':
      return 'Wait a moment, then try again.'
    case 'NOT_FOUND':
      return 'That item is no longer available.'
    default:
      return 'Something went wrong. Try again when the connection is back.'
  }
}

export function requestWords(kind: string, needs: string, quantity: number): string {
  if (kind === 'charging' && needs === 'accessible_slot') return '1 accessible charging spot'
  if (kind === 'charging') return '1 charging spot'
  return `${quantity} water`
}

export function resourceWords(kind: string, accessible: boolean): string {
  if (kind === 'water_stock') return 'Water'
  return accessible ? 'Accessible charger' : 'Standard charger'
}

export function formatWhen(ms: number | null): string {
  if (ms === null) return 'not yet'
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export function formatWait(fromMs: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - fromMs) / 60_000))
  if (minutes < 1) return 'under 1 min'
  if (minutes === 1) return '1 min'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`
}

export function timestampMs(value: { microsSinceUnixEpoch?: bigint } | null | undefined): number | null {
  if (!value || typeof value.microsSinceUnixEpoch !== 'bigint') return null
  return Number(value.microsSinceUnixEpoch / 1000n)
}
