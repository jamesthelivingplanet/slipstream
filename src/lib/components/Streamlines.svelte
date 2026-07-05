<script lang="ts">
  /**
   * Ambient telemetry background for Mission Control: faint neutral field
   * lines plus one tinted line per live session (blue for running, amber for
   * needs-you). Purely decorative (aria-hidden) — never blocks pointer events.
   *
   * Colors are read from the app's real CSS custom properties at draw time so
   * the canvas follows the light/dark theme without any hardcoded values.
   */
  import { onMount, onDestroy } from 'svelte'

  /** Count of currently-running sessions (drives blue lines + overall speed). */
  export let running: number = 0
  /** Count of sessions waiting on the user (drives amber lines). */
  export let needs: number = 0

  type Line = { x: number; y: number; len: number; v: number; kind: 'field' | 'run' | 'needs' }

  let canvasEl: HTMLCanvasElement
  let ctx: CanvasRenderingContext2D | null = null
  let raf: number | null = null
  let mounted = false
  let reduced = false
  let W = 0
  let H = 0
  let lines: Line[] = []

  function cssHsl(varName: string, alpha: number): string {
    const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim()
    return `hsl(${v} / ${alpha})`
  }

  function seed() {
    const next: Line[] = []
    const fieldCount = Math.max(14, Math.floor(H / 46))
    for (let i = 0; i < fieldCount; i++) {
      next.push({
        y: ((i + 0.5) / fieldCount) * H + (Math.random() - 0.5) * 18,
        x: Math.random() * W,
        len: 60 + Math.random() * 160,
        v: 0.15 + Math.random() * 0.25,
        kind: 'field',
      })
    }
    const sessionKinds: ('run' | 'needs')[] = [
      ...Array(Math.max(0, running)).fill('run'),
      ...Array(Math.max(0, needs)).fill('needs'),
    ]
    sessionKinds.forEach((kind, i) => {
      next.push({
        y:
          H * (0.12 + 0.76 * (i / Math.max(1, sessionKinds.length - 1))) +
          (Math.random() - 0.5) * 30,
        x: Math.random() * W,
        len: 140 + Math.random() * 120,
        v: kind === 'run' ? 0.9 + Math.random() * 0.5 : 0.25,
        kind,
      })
    })
    lines = next
  }

  function resize() {
    if (!canvasEl || !ctx) return
    const dpr = window.devicePixelRatio || 1
    W = canvasEl.clientWidth
    H = canvasEl.clientHeight
    canvasEl.width = W * dpr
    canvasEl.height = H * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    seed()
    if (reduced) draw()
  }

  function draw() {
    if (!ctx) return
    ctx.clearRect(0, 0, W, H)
    const fg = cssHsl('--muted-foreground', 0.1)
    const run = cssHsl('--st-run', 0.28)
    const needsColor = cssHsl('--st-needs', 0.26)
    for (const l of lines) {
      const grad = ctx.createLinearGradient(l.x - l.len, l.y, l.x, l.y)
      const color = l.kind === 'run' ? run : l.kind === 'needs' ? needsColor : fg
      grad.addColorStop(0, 'transparent')
      grad.addColorStop(1, color)
      ctx.strokeStyle = grad
      ctx.lineWidth = l.kind === 'field' ? 1 : 1.5
      ctx.beginPath()
      ctx.moveTo(l.x - l.len, l.y)
      ctx.lineTo(l.x, l.y)
      ctx.stroke()
      if (!reduced) {
        l.x += l.v
        if (l.x - l.len > W) {
          l.x = -10
          l.y = Math.random() * H
        }
      }
    }
    if (!reduced) raf = requestAnimationFrame(draw)
  }

  onMount(() => {
    ctx = canvasEl.getContext('2d')
    reduced =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    resize()
    window.addEventListener('resize', resize)
    if (!reduced) raf = requestAnimationFrame(draw)
    mounted = true
  })

  onDestroy(() => {
    if (raf !== null) cancelAnimationFrame(raf)
    if (typeof window !== 'undefined') window.removeEventListener('resize', resize)
  })

  // Re-seed (and, under reduced-motion, redraw a single static frame) whenever
  // the live session counts change.
  $: if (mounted) {
    void running
    void needs
    if (W && H) {
      seed()
      if (reduced) draw()
    }
  }
</script>

<canvas bind:this={canvasEl} aria-hidden="true"></canvas>

<style>
  canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
  }
</style>
