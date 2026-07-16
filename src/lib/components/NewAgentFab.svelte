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
    <svg viewBox="0 0 11 11" class="glyph" aria-hidden="true" focusable="false">
      <g class="glyph-body">
        <!-- tapering cross spikes -->
        <rect x="5" y="1" width="1" height="1" class="px px-tip" />
        <rect x="5" y="2" width="1" height="1" class="px px-limb" />
        <rect x="5" y="8" width="1" height="1" class="px px-limb" />
        <rect x="5" y="9" width="1" height="1" class="px px-tip" />
        <rect x="1" y="5" width="1" height="1" class="px px-tip" />
        <rect x="2" y="5" width="1" height="1" class="px px-limb" />
        <rect x="8" y="5" width="1" height="1" class="px px-limb" />
        <rect x="9" y="5" width="1" height="1" class="px px-tip" />
        <!-- core diamond (Manhattan distance 2 from center) -->
        <rect x="5" y="3" width="1" height="1" class="px px-core" />
        <rect x="5" y="7" width="1" height="1" class="px px-core" />
        <rect x="4" y="4" width="1" height="1" class="px px-core" />
        <rect x="6" y="4" width="1" height="1" class="px px-core" />
        <rect x="4" y="6" width="1" height="1" class="px px-core" />
        <rect x="6" y="6" width="1" height="1" class="px px-core" />
        <rect x="3" y="5" width="1" height="1" class="px px-core" />
        <rect x="7" y="5" width="1" height="1" class="px px-core" />
        <!-- halo ring (Manhattan distance 1) -->
        <rect x="5" y="4" width="1" height="1" class="px px-halo" />
        <rect x="5" y="6" width="1" height="1" class="px px-halo" />
        <rect x="4" y="5" width="1" height="1" class="px px-halo" />
        <rect x="6" y="5" width="1" height="1" class="px px-halo" />
        <!-- eye (center) -->
        <rect x="5" y="5" width="1" height="1" class="px px-eye" />
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
    width: 30px;
    height: 30px;
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

  /* Idle: a slow, quiet float — kept small in amplitude so it never distracts
     from reading a terminal behind it. */
  .glyph-body {
    animation: fab-float 4.5s ease-in-out infinite;
    transform-origin: 5.5px 5.5px;
  }

  .px-core {
    fill: hsl(var(--primary-foreground) / 0.9);
  }
  .px-halo {
    fill: hsl(var(--primary-foreground) / 0.7);
    animation: fab-shimmer 6s ease-in-out infinite;
  }
  .px-limb {
    fill: hsl(var(--primary-foreground) / 0.4);
  }
  .px-tip {
    fill: hsl(var(--primary-foreground) / 0.2);
  }
  .px-eye {
    fill: hsl(var(--primary-foreground));
    animation: fab-blink 5.2s ease-in-out infinite;
  }

  @keyframes fab-float {
    0%,
    100% {
      transform: translateY(0);
    }
    50% {
      transform: translateY(-0.6px);
    }
  }

  @keyframes fab-shimmer {
    0%,
    100% {
      opacity: 0.7;
    }
    50% {
      opacity: 0.85;
    }
  }

  @keyframes fab-blink {
    0%,
    92%,
    100% {
      opacity: 1;
    }
    95% {
      opacity: 0.3;
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
    .px-eye,
    .px-halo {
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
