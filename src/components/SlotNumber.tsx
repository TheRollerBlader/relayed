/** Vertical digit slide for stock and case counts. Remounts when the value changes so the ring plays once. */
export function SlotNumber({ value }: { value: number }) {
  const digits = String(Math.max(0, Math.round(value))).padStart(2, '0').split('')
  return (
    <span className="slot-number" key={value} aria-label={String(value)}>
      {digits.map((digit, index) => (
        <span className="slot-window" key={`${index}-${digits.length}`}>
          <span className="slot-reel" style={{ transform: `translateY(-${Number(digit) * 10}%)` }}>
            {'0123456789'.split('').map((item) => (
              <span key={item}>{item}</span>
            ))}
          </span>
        </span>
      ))}
    </span>
  )
}
