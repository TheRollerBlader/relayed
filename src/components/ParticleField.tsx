import { useEffect, useRef } from 'react'

/** Fixed, non-interactive midnight atmosphere. Particles stay behind the app. */
export function ParticleField() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const count = 56
    const particles = Array.from({ length: count }, () => ({
      x: Math.random(),
      y: Math.random(),
      radius: 1 + Math.random() * 1.5,
      speed: 0.12 + Math.random() * 0.06,
      opacity: 0.15 + Math.random() * 0.2,
    }))
    let width = 0
    let height = 0
    let frame = 0
    let mouseX = 0.5
    let mouseY = 0.25
    let targetX = 0.5
    let targetY = 0.25

    const resize = () => {
      width = canvas.width = window.innerWidth
      height = canvas.height = window.innerHeight
    }
    const onMove = (event: PointerEvent) => {
      targetX = event.clientX / Math.max(window.innerWidth, 1)
      targetY = event.clientY / Math.max(window.innerHeight, 1)
      document.documentElement.style.setProperty('--mouse-x', `${event.clientX}px`)
      document.documentElement.style.setProperty('--mouse-y', `${event.clientY}px`)
    }
    const draw = () => {
      frame = window.requestAnimationFrame(draw)
      mouseX += (targetX - mouseX) * 0.08
      mouseY += (targetY - mouseY) * 0.08
      context.clearRect(0, 0, width, height)
      for (const particle of particles) {
        if (!reduce) {
          particle.y -= particle.speed / Math.max(height, 1)
          particle.x += (mouseX - 0.5) * 0.0009
          if (particle.y < 0) particle.y += 1
          if (particle.x < 0) particle.x += 1
          if (particle.x > 1) particle.x -= 1
        }
        context.beginPath()
        context.fillStyle = `rgba(255,255,255,${particle.opacity})`
        context.arc(particle.x * width + (mouseX - 0.5) * 14, particle.y * height + (mouseY - 0.5) * 10, particle.radius, 0, Math.PI * 2)
        context.fill()
      }
    }

    resize()
    window.addEventListener('resize', resize)
    window.addEventListener('pointermove', onMove, { passive: true })
    frame = window.requestAnimationFrame(draw)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', resize)
      window.removeEventListener('pointermove', onMove)
    }
  }, [])

  return (
    <>
      <canvas ref={canvasRef} className="particle-field" aria-hidden="true" />
      <div className="cursor-spotlight" aria-hidden="true" />
    </>
  )
}
