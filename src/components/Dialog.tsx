import { useEffect, useRef } from 'react'

export function Dialog({
  title,
  body,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  title: string
  body: string
  confirmLabel: string
  onConfirm: () => void
  onClose: () => void
}) {
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const root = panel.current
    const items = () =>
      [...(root?.querySelectorAll<HTMLElement>('button, [href], input, select, textarea') ?? [])]
    items()[0]?.focus()

    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const nodes = items()
      if (nodes.length === 0) return
      const first = nodes[0]
      const last = nodes[nodes.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }

    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      previous?.focus()
    }
  }, [onClose])

  return (
    <div className="fixed inset-0 z-20 grid place-items-center bg-canvas/80 px-5" role="presentation">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        className="w-full max-w-md border border-line bg-panel p-5"
      >
        <h2 id="dialog-title" className="text-lg font-medium">
          {title}
        </h2>
        <p className="mt-3 text-sm text-muted">{body}</p>
        <div className="mt-5 flex flex-wrap gap-3">
          <button type="button" onClick={onConfirm} className={primaryButton}>
            {confirmLabel}
          </button>
          <button type="button" onClick={onClose} className={quietButton}>
            Go back
          </button>
        </div>
      </div>
    </div>
  )
}

export const primaryButton =
  'inline-flex min-h-12 items-center justify-center border border-accent bg-accent px-4 text-sm font-medium text-accent-ink disabled:cursor-not-allowed disabled:border-line disabled:bg-transparent disabled:text-faint'

export const quietButton =
  'inline-flex min-h-12 items-center justify-center border border-line px-4 text-sm hover:border-accent disabled:cursor-not-allowed disabled:text-faint'
