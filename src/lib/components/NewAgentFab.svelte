<script lang="ts">
  import { dialogOpen, settingsOpen, mobile, keyboardInset } from '../stores'
  import { shouldShowFab } from '../responsive'

  let btn: HTMLButtonElement

  $: visible = shouldShowFab($mobile, $dialogOpen, $settingsOpen, $keyboardInset)

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
</script>

{#if visible}
  <button
    bind:this={btn}
    type="button"
    class="new-agent-fab"
    aria-label="New agent"
    title="New agent"
    on:click={handleClick}
    on:animationend={clearPressed}
  >
    <span class="ripple"></span>
    <!-- Deliberately NOT radially symmetric: an off-center lumpy mass, unequal
         limbs, a broken halo (arc + a piece that drifted loose), a few
         drooping tendrils, and eyes that don't belong where they are. It
         should almost read as a familiar compass-rose/angel shape and then
         not quite. -->
    <svg viewBox="0 0 15 15" class="glyph" aria-hidden="true" focusable="false">
      <g class="glyph-body">
        <!-- broken halo: an arc that slipped off to one side, with a gap
             where it should continue — plus one fragment that sheared off
             and floats apart, away from the rest -->
        <rect x="5" y="2" width="1" height="1" class="px px-halo" />
        <rect x="6" y="1" width="1" height="1" class="px px-halo" />
        <rect x="7" y="1" width="1" height="1" class="px px-halo" />
        <rect x="11" y="1" width="1" height="1" class="px px-halo-frag" />

        <!-- top limb: long, tapering, feeding into the head, with a slight
             kink at the tip like a bent horn -->
        <rect x="9" y="0" width="1" height="1" class="px px-tip" />
        <rect x="9" y="1" width="1" height="1" class="px px-tip" />
        <rect x="9" y="2" width="1" height="1" class="px px-limb" />
        <rect x="9" y="3" width="1" height="1" class="px px-limb" />

        <!-- small head, off the body's centerline, one cyclopean eye -->
        <rect x="8" y="4" width="1" height="1" class="px px-core" />
        <rect x="9" y="4" width="1" height="1" class="px px-core" />
        <rect x="7" y="5" width="1" height="1" class="px px-core" />
        <rect x="9" y="5" width="1" height="1" class="px px-core" />
        <rect x="9" y="6" width="1" height="1" class="px px-core" />
        <rect x="8" y="6" width="1" height="1" class="px px-core" />

        <!-- left limb: shorter than the top, straight, low on the body -->
        <rect x="2" y="8" width="1" height="1" class="px px-tip" />
        <rect x="3" y="8" width="1" height="1" class="px px-limb" />
        <rect x="4" y="8" width="1" height="1" class="px px-limb" />

        <!-- right limb: shortest of all, and it doesn't taper to a clean
             point — it snaps off, and the eye that should have ended it
             floats loose past the gap -->
        <rect x="11" y="8" width="1" height="1" class="px px-limb" />

        <!-- bottom stub: short, shifted off the vertical axis (asymmetric
             against the long top limb), and not quite touching the body -->
        <rect x="6" y="12" width="1" height="1" class="px px-limb" />
        <rect x="6" y="13" width="1" height="1" class="px px-tip" />

        <!-- lumpy, asymmetric body mass — heavier toward the bottom-right,
             ragged edges rather than a clean diamond, joined to the head by
             an off-axis neck -->
        <rect x="8" y="7" width="1" height="1" class="px px-core" />
        <rect x="6" y="7" width="1" height="1" class="px px-core" />
        <rect x="5" y="8" width="1" height="1" class="px px-core" />
        <rect x="6" y="8" width="1" height="1" class="px px-core" />
        <rect x="7" y="8" width="1" height="1" class="px px-core" />
        <rect x="8" y="8" width="1" height="1" class="px px-core" />
        <rect x="9" y="8" width="1" height="1" class="px px-core" />
        <rect x="10" y="8" width="1" height="1" class="px px-core" />
        <rect x="7" y="9" width="1" height="1" class="px px-core" />
        <rect x="8" y="9" width="1" height="1" class="px px-core" />
        <rect x="9" y="9" width="1" height="1" class="px px-core" />
        <rect x="6" y="10" width="1" height="1" class="px px-core" />
        <rect x="7" y="10" width="1" height="1" class="px px-core" />
        <rect x="8" y="10" width="1" height="1" class="px px-core" />
        <rect x="7" y="11" width="1" height="1" class="px px-core" />

        <!-- drooping tendrils off the lower mass, unequal lengths -->
        <rect x="4" y="10" width="1" height="1" class="px px-tendril" />
        <rect x="3" y="11" width="1" height="1" class="px px-tendril" />
        <rect x="3" y="12" width="1" height="1" class="px px-tendril" />
        <rect x="9" y="10" width="1" height="1" class="px px-tendril" />
        <rect x="9" y="11" width="1" height="1" class="px px-tendril" />
        <rect x="8" y="12" width="1" height="1" class="px px-tendril" />

        <!-- eyes: one large cyclopean eye on the head; two smaller and
             mismatched on the body; one that shouldn't exist, drifted loose
             past the broken right limb, mostly closed -->
        <rect x="8" y="5" width="1" height="1" class="px px-eye-main" />
        <rect x="6" y="9" width="1" height="1" class="px px-eye-a" />
        <rect x="10" y="7" width="1" height="1" class="px px-eye-b" />
        <rect x="13" y="8" width="1" height="1" class="px px-eye-rare" />
      </g>
    </svg>
  </button>
{/if}

<style>
  /* Fixed bottom-right, respecting safe areas, sized well above the 44px
     touch-target minimum. z-index kept below ResponsivePanel's dialog
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
    background: hsl(var(--primary));
    border: none;
    box-shadow: var(--shadow);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    cursor: pointer;
    z-index: 40;
  }

  .new-agent-fab:hover {
    opacity: 0.92;
  }

  .new-agent-fab:focus-visible {
    outline: 2px solid hsl(var(--ring));
    outline-offset: 3px;
  }

  .new-agent-fab .glyph {
    width: 32px;
    height: 32px;
    shape-rendering: crispEdges;
    position: relative;
  }

  /* AT-field-style hexagonal ripple, expands from the button on press. */
  .new-agent-fab .ripple {
    position: absolute;
    inset: -16px;
    clip-path: polygon(50% 0%, 93% 25%, 93% 75%, 50% 100%, 7% 75%, 7% 25%);
    background: hsl(var(--primary) / 0.45);
    opacity: 0;
    transform: scale(0.3);
    pointer-events: none;
  }

  /* Idle: a slow, quiet drift with one brief 1px glitch displacement per
     cycle — kept small in amplitude so it never distracts from reading a
     terminal behind it. 7.3s is deliberately not a clean multiple of the
     eye-blink durations below, so the glitch and the blinks drift in and out
     of phase with each other rather than reading as one synced loop. */
  .glyph-body {
    animation: fab-float 7.3s ease-in-out infinite;
    transform-origin: 7.5px 7.5px;
  }

  .px-core {
    fill: hsl(var(--primary-foreground) / 0.9);
  }
  .px-halo {
    fill: hsl(var(--primary-foreground) / 0.7);
    animation: fab-shimmer 6s ease-in-out infinite;
  }
  /* The fragment that sheared off the halo — same family, drifts on its own
     out-of-phase timing so it reads as loose rather than orbiting in sync. */
  .px-halo-frag {
    fill: hsl(var(--primary-foreground) / 0.55);
    animation: fab-shimmer 4.1s ease-in-out infinite;
  }
  .px-limb {
    fill: hsl(var(--primary-foreground) / 0.4);
  }
  .px-tip {
    fill: hsl(var(--primary-foreground) / 0.2);
  }
  .px-tendril {
    fill: hsl(var(--primary-foreground) / 0.25);
  }

  /* Eyes: a fixed deep red rather than hsl(var(--primary-foreground)) — this
     app has no --destructive token defined in src/app.css (checked: zero
     matches), and the eye needs to read as a consistent blood-red core
     across all six --primary accent themes × light/dark. var(--destructive,
     …) is used anyway so a future theme token would be picked up for free;
     until then the fallback triple is the actual color. */
  .px-eye-main,
  .px-eye-a,
  .px-eye-b,
  .px-eye-rare {
    fill: hsl(var(--destructive, 350 80% 45%));
  }
  .px-eye-main {
    animation: fab-blink-main 5.2s ease-in-out infinite;
  }
  /* Two smaller, dimmer eyes that blink out of sync with the main one and
     with each other. */
  .px-eye-a {
    fill: hsl(var(--destructive, 350 80% 45%) / 0.65);
    animation: fab-blink-a 6.7s ease-in-out infinite;
    animation-delay: -1.4s;
  }
  .px-eye-b {
    fill: hsl(var(--destructive, 350 80% 45%) / 0.55);
    animation: fab-blink-b 4.3s ease-in-out infinite;
    animation-delay: -2.6s;
  }
  /* An eye that shouldn't be there, out on the broken limb — stays almost
     shut and only rarely, briefly opens. */
  .px-eye-rare {
    fill: hsl(var(--destructive, 350 80% 45%) / 0.15);
    animation: fab-eye-rare 12.6s ease-in-out infinite;
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

  @keyframes fab-blink-b {
    0%,
    93%,
    100% {
      opacity: 1;
    }
    96% {
      opacity: 0.2;
    }
  }

  @keyframes fab-eye-rare {
    0%,
    85%,
    100% {
      opacity: 0.15;
    }
    90% {
      opacity: 0.9;
    }
    94% {
      opacity: 0.15;
    }
  }

  /* Press: squash-and-stretch on the button + the hex ripple firing once. */
  .new-agent-fab.pressed {
    animation: fab-squash 0.32s cubic-bezier(0.36, 1.9, 0.4, 1) 1;
  }
  .new-agent-fab.pressed .ripple {
    animation: fab-ripple 0.5s ease-out 1;
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
    .glyph-body,
    .px-halo,
    .px-halo-frag,
    .px-eye-main,
    .px-eye-a,
    .px-eye-b,
    .px-eye-rare {
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
</style>
