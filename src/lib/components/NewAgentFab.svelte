<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { fade } from 'svelte/transition'
  import { dialogOpen, settingsOpen, mobile, keyboardInset, selected } from '../stores'
  import { shouldShowFab } from '../responsive'
  import { icons } from '../icons'
  import { nativeStorage } from '../nativeStorage'
  import { fabAngelEnabled, fabTipsEnabled, initFabPrefs } from '../fabPrefs'
  import { FAB_TIPS } from '../fabTipsContent'
  import {
    FAB_TIP_INDEX_KEY,
    firstTipDueAtMs,
    isTipDue,
    tipAutoHideAtMs,
    nextTipDueAtMs,
    nextTipIndex,
    clampTipIndex,
  } from '../fabTips'

  let btn: HTMLButtonElement
  let reducedMotion = false

  $: visible = shouldShowFab($mobile, $dialogOpen, $settingsOpen, $keyboardInset)

  // ── Clippy-mode tip bubble (TASK-I9S44) ──────────────────────────────────
  // Scheduling math lives in fabTips.ts (pure, unit-tested); this component
  // just polls it once a second and owns the nativeStorage read/writes.
  //
  // Tips are only eligible while the FAB itself is visible AND no session is
  // selected (mission control / agent list). A selected session can pin
  // MobileTermInput to the bottom of the screen, and the bubble must never
  // overlap it — gating on "no session selected" guarantees that by
  // construction rather than trying to measure the composer at runtime.
  let tipIndex = 0
  let currentTip: string | null = null
  let tipDueAtMs = Infinity
  let tipShownAtMs = 0
  let tickHandle: ReturnType<typeof setInterval> | undefined

  $: tipsEligible = visible && $fabTipsEnabled && !$selected && FAB_TIPS.length > 0

  // A tip that's currently up but whose eligibility just dropped (dialog
  // opened, settings opened, a session got selected) is cleared immediately
  // rather than left floating with nothing to anchor to.
  $: if (!tipsEligible && currentTip !== null) hideTip()

  function showTip(nowMs: number) {
    currentTip = FAB_TIPS[tipIndex] ?? null
    tipShownAtMs = nowMs
  }

  function hideTip() {
    currentTip = null
    tipIndex = nextTipIndex(tipIndex, FAB_TIPS.length)
    void nativeStorage.set(FAB_TIP_INDEX_KEY, String(tipIndex))
    tipDueAtMs = nextTipDueAtMs(Date.now())
  }

  function dismissTip() {
    hideTip()
  }

  function tick() {
    const now = Date.now()
    if (currentTip !== null) {
      if (now >= tipAutoHideAtMs(tipShownAtMs)) hideTip()
      return
    }
    if (tipsEligible && isTipDue(now, tipDueAtMs)) showTip(now)
  }

  // Imperative classList (not a Svelte `class:` binding) so a rapid second tap
  // restarts the CSS press animation via a forced reflow — a reactive
  // class:pressed binding wouldn't remove-then-add synchronously enough to retrigger it.
  function handleClick() {
    dialogOpen.set(true)
    if (!btn) return
    btn.classList.remove('pressed')
    void btn.offsetWidth
    btn.classList.add('pressed')
  }

  function clearPressed() {
    btn?.classList.remove('pressed')
  }

  onMount(async () => {
    reducedMotion =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

    await initFabPrefs()
    let storedIndex = 0
    try {
      const raw = await nativeStorage.get(FAB_TIP_INDEX_KEY)
      storedIndex = raw ? parseInt(raw, 10) : 0
    } catch {
      storedIndex = 0
    }
    tipIndex = clampTipIndex(storedIndex, FAB_TIPS.length)
    tipDueAtMs = firstTipDueAtMs(Date.now())
    tickHandle = setInterval(tick, 1000)
  })

  onDestroy(() => {
    if (tickHandle) clearInterval(tickHandle)
  })
</script>

{#if visible}
  <button
    bind:this={btn}
    type="button"
    class="new-agent-fab"
    class:regular={!$fabAngelEnabled}
    aria-label="New agent"
    title="New agent"
    on:click={handleClick}
    on:animationend={clearPressed}
  >
    {#if !$fabAngelEnabled}
      <!-- Angel mode off: the pre-angel look — a plain primary-colored disc
           with the header's old plus glyph. No sprite, no idle animation. -->
      <span class="regular-icon" aria-hidden="true">{@html icons.plus}</span>
    {:else}
      <span class="ripple"></span>
      <!-- "The geometer": a hollow diamond lattice built from two arcs (upper-left,
         lower-right) that shimmer on offset cycles like a slow sweep. The arcs
         don't quite meet — the seam on the upper-right edge is torn open, and a
         dark shard shows through the gap where the lattice should continue,
         plus a loose fleck sheared off near the lower rim. A red core sits off
         from the shape's true center, with a dim echo pixel riding beside it. -->
      <svg viewBox="0 0 13 13" class="glyph" aria-hidden="true" focusable="false">
        <g class="glyph-spin">
          <g class="glyph-body">
            <!-- ring, arc 1: top vertex down through the left flank -->
            <rect x="6" y="0" width="1" height="1" class="px px-ring-1" />
            <rect x="5" y="1" width="1" height="1" class="px px-ring-1" />
            <rect x="6" y="1" width="1" height="1" class="px px-ring-1" />
            <rect x="7" y="1" width="1" height="1" class="px px-ring-1" />
            <rect x="4" y="2" width="1" height="1" class="px px-ring-1" />
            <rect x="5" y="2" width="1" height="1" class="px px-ring-1" />
            <rect x="7" y="2" width="1" height="1" class="px px-ring-1" />
            <rect x="3" y="3" width="1" height="1" class="px px-ring-1" />
            <rect x="4" y="3" width="1" height="1" class="px px-ring-1" />
            <rect x="2" y="4" width="1" height="1" class="px px-ring-1" />
            <rect x="3" y="4" width="1" height="1" class="px px-ring-1" />
            <rect x="1" y="5" width="1" height="1" class="px px-ring-1" />
            <rect x="2" y="5" width="1" height="1" class="px px-ring-1" />
            <rect x="0" y="6" width="1" height="1" class="px px-ring-1" />
            <rect x="1" y="6" width="1" height="1" class="px px-ring-1" />
            <rect x="1" y="7" width="1" height="1" class="px px-ring-1" />
            <rect x="2" y="7" width="1" height="1" class="px px-ring-1" />
            <rect x="2" y="8" width="1" height="1" class="px px-ring-1" />
            <rect x="3" y="8" width="1" height="1" class="px px-ring-1" />
            <rect x="3" y="9" width="1" height="1" class="px px-ring-1" />

            <!-- ring, arc 2: bottom vertex up through the right flank — shimmers
               on its own offset cycle so the lattice reads as a slow sweep
               rather than a uniform pulse -->
            <rect x="6" y="12" width="1" height="1" class="px px-ring-2" />
            <rect x="5" y="11" width="1" height="1" class="px px-ring-2" />
            <rect x="6" y="11" width="1" height="1" class="px px-ring-2" />
            <rect x="7" y="11" width="1" height="1" class="px px-ring-2" />
            <rect x="4" y="10" width="1" height="1" class="px px-ring-2" />
            <rect x="5" y="10" width="1" height="1" class="px px-ring-2" />
            <rect x="7" y="10" width="1" height="1" class="px px-ring-2" />
            <rect x="4" y="9" width="1" height="1" class="px px-ring-2" />
            <rect x="8" y="9" width="1" height="1" class="px px-ring-2" />
            <rect x="8" y="10" width="1" height="1" class="px px-ring-2" />
            <rect x="9" y="8" width="1" height="1" class="px px-ring-2" />
            <rect x="9" y="9" width="1" height="1" class="px px-ring-2" />
            <rect x="10" y="7" width="1" height="1" class="px px-ring-2" />
            <rect x="10" y="8" width="1" height="1" class="px px-ring-2" />
            <rect x="11" y="5" width="1" height="1" class="px px-ring-2" />
            <rect x="11" y="6" width="1" height="1" class="px px-ring-2" />
            <rect x="11" y="7" width="1" height="1" class="px px-ring-2" />
            <rect x="12" y="6" width="1" height="1" class="px px-ring-2" />
            <rect x="9" y="4" width="1" height="1" class="px px-ring-2" />
            <rect x="10" y="4" width="1" height="1" class="px px-ring-2" />
            <rect x="10" y="5" width="1" height="1" class="px px-ring-2" />

            <!-- the torn seam: where the ring should close on the upper-right
               edge it doesn't — a dark shard shows through the gap instead -->
            <rect x="7" y="3" width="1" height="1" class="px px-shard" />
            <rect x="7" y="4" width="1" height="1" class="px px-shard" />

            <!-- a loose fleck, sheared off the lattice near the lower rim -->
            <rect x="5" y="9" width="1" height="1" class="px px-debris" />

            <!-- off-center core, with a dim echo pixel riding beside it -->
            <rect x="8" y="7" width="1" height="1" class="px px-eye-core" />
            <rect x="9" y="7" width="1" height="1" class="px px-eye-echo" />
          </g>
        </g>
      </svg>
    {/if}
  </button>
{/if}

{#if currentTip}
  <!-- Clippy-mode tip bubble: anchored above the FAB (never over its 56px hit
       area, so it can never intercept a tap meant for the FAB) and gated on
       "no session selected" (see tipsEligible above) so it can never overlap
       MobileTermInput either. aria-live="polite" per the brief so a screen
       reader announces it without interrupting. -->
  <div class="fab-tip" aria-live="polite" transition:fade={{ duration: reducedMotion ? 0 : 140 }}>
    <span class="fab-tip-label">the angel observes</span>
    <p class="fab-tip-text">{currentTip}</p>
    <button type="button" class="fab-tip-dismiss" aria-label="Dismiss tip" on:click={dismissTip}>
      ×
    </button>
    <span class="fab-tip-pointer" aria-hidden="true"></span>
  </div>
{/if}

<style>
  /* Fixed bottom-right, respecting safe areas. The button itself is a fully
     transparent 56px hit area (well above the 44px touch-target minimum) —
     no disc, no border, no shadow. The pixel angel is the only visible
     thing; it floats directly over whatever's behind it (including
     terminal content). border-radius is kept purely so the focus-visible
     outline below renders as a rounded ring around the invisible hit area
     rather than a square one. z-index kept below ResponsivePanel's dialog
     overlay (50) and panel (51) so it never fights a modal for taps. */
  .new-agent-fab {
    position: fixed;
    right: max(20px, calc(env(safe-area-inset-right) + 16px));
    bottom: max(20px, calc(env(safe-area-inset-bottom) + 16px));
    width: 56px;
    height: 56px;
    min-width: 44px;
    min-height: 44px;
    border-radius: 50%;
    background: transparent;
    border: none;
    box-shadow: none;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    cursor: pointer;
    touch-action: manipulation;
    z-index: 40;
  }

  .new-agent-fab:hover .glyph {
    opacity: 0.85;
  }

  /* Face is gone, so the focus ring is the only affordance that the hit
     area exists — draw it deliberately, keyboard-focus only. */
  .new-agent-fab:focus-visible {
    outline: 2px solid hsl(var(--ring));
    outline-offset: 3px;
  }

  /* Angel mode off (TASK-I9S44 settings toggle): the pre-angel look — a
     regular material-style disc, matching .btn-primary's tokens (see
     app.css) rather than the transparent hit area above. No sprite, no idle
     animation; press feedback is a plain scale instead of squash+ripple. */
  .new-agent-fab.regular {
    background: hsl(var(--primary));
    box-shadow: var(--shadow);
  }
  .new-agent-fab.regular:hover {
    opacity: 0.92;
  }
  .new-agent-fab.regular:focus-visible {
    outline-offset: 2px;
  }
  .regular-icon {
    display: inline-flex;
    color: hsl(var(--primary-foreground));
  }
  .regular-icon :global(svg) {
    width: 26px;
    height: 26px;
  }

  /* A touch larger than before (32px) now that nothing constrains it to a
     disc's interior — judged for legibility against the wider hit area. */
  .new-agent-fab .glyph {
    width: 40px;
    height: 40px;
    shape-rendering: crispEdges;
    position: relative;
    /* Background-colored (opposite luminance from the body fill) halo so
       the glyph separates from busy terminal content in both themes: two
       tight passes for a crisp edge, one wider soft pass for a glow. */
    filter: drop-shadow(0 0 1px hsl(var(--background))) drop-shadow(0 0 1px hsl(var(--background)))
      drop-shadow(0 0 3px hsl(var(--background) / 0.75));
  }

  /* AT-field-style hexagonal ripple, now emanating from the glyph itself
     (there's no disc to expand from). Centered the same as the glyph since
     the hit area and glyph share a center. */
  .new-agent-fab .ripple {
    position: absolute;
    inset: -12px;
    clip-path: polygon(50% 0%, 93% 25%, 93% 75%, 50% 100%, 7% 75%, 7% 25%);
    background: hsl(var(--foreground) / 0.35);
    opacity: 0;
    transform: scale(0.3);
    pointer-events: none;
  }

  /* Rotation wraps float rather than fighting it for the transform property —
     two nested groups, each animating its own transform, so a quarter-turn
     and the idle bob compose instead of clobbering each other. Origin is the
     13-unit viewBox's exact center so turns are pixel-true. */
  .glyph-spin {
    transform-origin: 6.5px 6.5px;
    animation: fab-rotate 11.2s ease-in-out infinite;
    /* Each 11.2s cycle is authored as a single quick turn ending at 90deg
       (see keyframes below); `accumulate` composition adds that 90deg onto
       whatever the previous cycle already turned, so successive cycles read
       as repeated quarter-turns (90 -> 180 -> 270 -> 360==0) instead of
       snapping back to 0deg every iteration. Needs Chromium 112+ / Safari
       17.4+ / Firefox 114+ — comfortably covered by Electron 33's Chromium.
       Where unsupported, this just degrades to the same 0->90 turn repeating
       without accumulating: still a working glyph, only less varied. */
    animation-composition: accumulate;
  }

  /* Idle: a slow, quiet drift with one brief 1px glitch displacement per
     cycle — kept small in amplitude so it never distracts from reading a
     terminal behind it. 7.3s is deliberately not a clean multiple of the
     eye-blink durations below, so the glitch and the blinks drift in and out
     of phase with each other rather than reading as one synced loop. */
  .glyph-body {
    animation: fab-float 7.3s ease-in-out infinite;
    transform-origin: 6.5px 6.5px;
  }

  /* Lattice fill: hsl(var(--foreground)) rather than --primary-foreground. The
     old fill was chosen for contrast against the --primary disc, which is
     now gone — --foreground is dark-on-light / light-on-dark by
     construction (see src/app.css), so it stays legible over arbitrary
     content in both themes on its own; the drop-shadow halo on .glyph
     above (background-colored) does the rest of the separation work. The
     two arcs get slightly different fill levels (0.7 / 0.55) so the sweep
     between them reads even at rest, before the shimmer animation moves. */
  .px-ring-1 {
    fill: hsl(var(--foreground) / 0.7);
    animation: fab-shimmer 5.5s ease-in-out infinite;
  }
  .px-ring-2 {
    fill: hsl(var(--foreground) / 0.55);
    animation: fab-shimmer 5.5s ease-in-out infinite;
    animation-delay: -2.75s;
  }
  /* Dark interior shard, glimpsed through the torn seam. A literal dark
     fill would vanish into the background in dark theme (both would be near
     -black), so instead it borrows the body's own foreground token at low
     opacity — it reads as "recessed" against the fully-lit ring pixels in
     both themes rather than fighting the background color directly. */
  .px-shard {
    fill: hsl(var(--foreground) / 0.3);
  }
  /* The loose fleck sheared off the lattice — same family, dimmer still. */
  .px-debris {
    fill: hsl(var(--foreground) / 0.25);
  }

  /* Core: a fixed deep red rather than hsl(var(--primary-foreground)) — this
     app has no --destructive token defined in src/app.css (checked: zero
     matches), and the core needs to read as a consistent blood-red across
     all six --primary accent themes x light/dark. var(--destructive, …) is
     used anyway so a future theme token would be picked up for free; until
     then the fallback triple is the actual color. */
  .px-eye-core,
  .px-eye-echo {
    fill: hsl(var(--destructive, 350 80% 45%));
  }
  /* Same 5.2s-style blink candidate A's main eye used: mostly open, a quick
     dip near the end of the cycle. */
  .px-eye-core {
    animation: fab-blink-main 5.2s ease-in-out infinite;
  }
  /* Dim echo riding beside the core, on its own out-of-sync period with a
     negative delay so the two never dip together — 5.2s and 6.7s share no
     small common multiple, and the delay offsets the phase further still. */
  .px-eye-echo {
    fill: hsl(var(--destructive, 350 80% 45%) / 0.4);
    animation: fab-blink-a 6.7s ease-in-out infinite;
    animation-delay: -1.4s;
  }

  @keyframes fab-float {
    0%,
    100% {
      transform: translate(0, 0);
    }
    45% {
      transform: translateY(-0.6px);
    }
    78% {
      transform: translateY(-0.6px);
    }
    /* the glitch: a single-frame 1px displacement, then settle */
    80% {
      transform: translate(1px, -1px);
    }
    82% {
      transform: translateY(-0.3px);
    }
  }

  /* One quick quarter-turn per cycle, then a long hold. The turn lands
     exactly on 90deg (0% and 100% are both exact multiples of 90) so the
     sprite is always pixel-aligned at rest; the overshoot/undershoot in
     between is momentary and the crisp-edge softening during it is
     acceptable since it's only ~0.5s of an 11.2s cycle. */
  @keyframes fab-rotate {
    0% {
      transform: rotate(0deg);
    }
    2% {
      transform: rotate(42deg);
    }
    3.5% {
      transform: rotate(100deg);
    }
    4.5% {
      transform: rotate(86deg);
    }
    5%,
    100% {
      transform: rotate(90deg);
    }
  }

  @keyframes fab-shimmer {
    0%,
    100% {
      opacity: 0.7;
    }
    50% {
      opacity: 0.9;
    }
  }

  @keyframes fab-blink-main {
    0%,
    90%,
    100% {
      opacity: 1;
    }
    94% {
      opacity: 0.25;
    }
  }

  @keyframes fab-blink-a {
    0%,
    88%,
    100% {
      opacity: 1;
    }
    92% {
      opacity: 0.15;
    }
  }

  /* Press: squash-and-stretch on the button + the hex ripple firing once.
     Angel mode only — .regular.pressed below has one more class so it wins
     on specificity and overrides this with a plain scale instead. */
  .new-agent-fab.pressed {
    animation: fab-squash 0.32s cubic-bezier(0.36, 1.9, 0.4, 1) 1;
  }
  .new-agent-fab.pressed .ripple {
    animation: fab-ripple 0.5s ease-out 1;
  }

  /* Regular-mode press feedback: simple scale-down, no squash/ripple. */
  .new-agent-fab.regular.pressed {
    animation: fab-regular-press 0.18s ease-out 1;
  }

  @keyframes fab-regular-press {
    0% {
      transform: scale(1);
    }
    45% {
      transform: scale(0.9);
    }
    100% {
      transform: scale(1);
    }
  }

  @keyframes fab-squash {
    0% {
      transform: scale(1, 1);
    }
    30% {
      transform: scale(1.1, 0.88);
    }
    55% {
      transform: scale(0.93, 1.07);
    }
    100% {
      transform: scale(1, 1);
    }
  }

  @keyframes fab-ripple {
    0% {
      opacity: 0.5;
      transform: scale(0.3);
    }
    100% {
      opacity: 0;
      transform: scale(1.9);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .glyph-spin,
    .glyph-body,
    .px-ring-1,
    .px-ring-2,
    .px-eye-core,
    .px-eye-echo {
      animation: none;
    }
    .new-agent-fab.pressed {
      animation: fab-flash 0.12s ease-out 1;
    }
    .new-agent-fab.pressed .ripple {
      animation: none;
    }
  }

  @keyframes fab-flash {
    0% {
      opacity: 0.7;
    }
    100% {
      opacity: 1;
    }
  }

  /* ── Clippy-mode tip bubble ────────────────────────────────────────────
     Anchored above the FAB using the exact same right/bottom formula so it
     tracks the FAB's own safe-area offset, with enough clearance (FAB height
     + gap) that its box never overlaps the FAB's 56px hit area — so it can
     never steal a tap meant for the FAB. Crisp corners (no border-radius)
     and a hard offset shadow instead of a blurred one, echoing the glyph's
     own crispEdges pixel language rather than the app's usual rounded
     cards. */
  .fab-tip {
    position: fixed;
    right: max(20px, calc(env(safe-area-inset-right) + 16px));
    bottom: calc(max(20px, calc(env(safe-area-inset-bottom) + 16px)) + 56px + 14px);
    max-width: min(272px, calc(100vw - 40px));
    z-index: 39;
    background: hsl(var(--popover));
    color: hsl(var(--foreground));
    border: 2px solid hsl(var(--border));
    box-shadow: 4px 4px 0 0 hsl(var(--foreground) / 0.16);
    padding: 9px 24px 11px 12px;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .fab-tip-label {
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: hsl(var(--muted-foreground));
  }

  .fab-tip-text {
    margin: 0;
    font-size: 12.5px;
    line-height: 1.45;
    color: hsl(var(--foreground));
  }

  .fab-tip-dismiss {
    position: absolute;
    top: 2px;
    right: 2px;
    width: 22px;
    height: 22px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: none;
    border-radius: 0;
    color: hsl(var(--muted-foreground));
    font-size: 15px;
    line-height: 1;
    cursor: pointer;
  }

  .fab-tip-dismiss:hover {
    color: hsl(var(--foreground));
  }

  .fab-tip-dismiss:focus-visible {
    outline: 2px solid hsl(var(--ring));
    outline-offset: 1px;
  }

  /* Pixel-diamond pointer echoing the glyph's own diamond-lattice shape —
     a rotated square with only two borders shown, the classic CSS
     speech-bubble-tail trick, kept crisp/unrounded to match. Positioned
     toward the FAB's right edge (roughly under its glyph). */
  .fab-tip-pointer {
    position: absolute;
    bottom: -8px;
    right: 22px;
    width: 12px;
    height: 12px;
    background: hsl(var(--popover));
    border-right: 2px solid hsl(var(--border));
    border-bottom: 2px solid hsl(var(--border));
    transform: rotate(45deg);
  }
</style>
