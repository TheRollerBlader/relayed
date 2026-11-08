export function ErrorBanner({
  title,
  text,
  onRetry,
}: {
  title: string
  text: string
  onRetry?: () => void
}) {
  return (
    <div role="alert" className="border border-line bg-panel px-4 py-3">
      <p className="font-mono text-[11px] tracking-[0.16em] text-accent">{title}</p>
      <p className="mt-2 text-sm">{text}</p>
      {onRetry && (
        <button type="button" onClick={onRetry} className="mt-3 min-h-12 text-sm text-accent">
          Try again
        </button>
      )}
    </div>
  )
}
