<script lang="ts">
  // Big-format render of the pixel-angel mascot (TASK-EQOP4), for onboarding.
  // Same 13x13 rect grid and class names (px-ring-1/px-ring-2/px-shard/
  // px-debris/px-eye-core/px-eye-echo) as the glyph in NewAgentFab.svelte —
  // copied rather than shared so NewAgentFab's markup/behavior stays
  // untouched, per the onboarding brief. This component owns its own idle
  // animation (a slower, gentler drift than the FAB's — there's no button
  // press/ripple/rotate here, just a mascot standing still) and its own
  // reduced-motion fallback, rather than importing the FAB's stylesheet.
  export let size = 96
  /** aria-hidden by default: callers pair this with their own visible label
   *  (nameplate/heading) rather than relying on this glyph for a11y. */
  export let ariaHidden = true

  let reducedMotion = false
  if (typeof matchMedia === 'function') {
    reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches
  }
</script>

<svg
  viewBox="0 0 13 13"
  width={size}
  height={size}
  class="onb-angel"
  class:reduced={reducedMotion}
  aria-hidden={ariaHidden}
  focusable="false"
>
  <g class="onb-angel-body">
    <!-- ring, arc 1: top vertex down through the left flank -->
    <rect x="6" y="0" width="1" height="1" class="px onb-ring-1" />
    <rect x="5" y="1" width="1" height="1" class="px onb-ring-1" />
    <rect x="6" y="1" width="1" height="1" class="px onb-ring-1" />
    <rect x="7" y="1" width="1" height="1" class="px onb-ring-1" />
    <rect x="4" y="2" width="1" height="1" class="px onb-ring-1" />
    <rect x="5" y="2" width="1" height="1" class="px onb-ring-1" />
    <rect x="7" y="2" width="1" height="1" class="px onb-ring-1" />
    <rect x="3" y="3" width="1" height="1" class="px onb-ring-1" />
    <rect x="4" y="3" width="1" height="1" class="px onb-ring-1" />
    <rect x="2" y="4" width="1" height="1" class="px onb-ring-1" />
    <rect x="3" y="4" width="1" height="1" class="px onb-ring-1" />
    <rect x="1" y="5" width="1" height="1" class="px onb-ring-1" />
    <rect x="2" y="5" width="1" height="1" class="px onb-ring-1" />
    <rect x="0" y="6" width="1" height="1" class="px onb-ring-1" />
    <rect x="1" y="6" width="1" height="1" class="px onb-ring-1" />
    <rect x="1" y="7" width="1" height="1" class="px onb-ring-1" />
    <rect x="2" y="7" width="1" height="1" class="px onb-ring-1" />
    <rect x="2" y="8" width="1" height="1" class="px onb-ring-1" />
    <rect x="3" y="8" width="1" height="1" class="px onb-ring-1" />
    <rect x="3" y="9" width="1" height="1" class="px onb-ring-1" />

    <!-- ring, arc 2: bottom vertex up through the right flank -->
    <rect x="6" y="12" width="1" height="1" class="px onb-ring-2" />
    <rect x="5" y="11" width="1" height="1" class="px onb-ring-2" />
    <rect x="6" y="11" width="1" height="1" class="px onb-ring-2" />
    <rect x="7" y="11" width="1" height="1" class="px onb-ring-2" />
    <rect x="4" y="10" width="1" height="1" class="px onb-ring-2" />
    <rect x="5" y="10" width="1" height="1" class="px onb-ring-2" />
    <rect x="7" y="10" width="1" height="1" class="px onb-ring-2" />
    <rect x="4" y="9" width="1" height="1" class="px onb-ring-2" />
    <rect x="8" y="9" width="1" height="1" class="px onb-ring-2" />
    <rect x="8" y="10" width="1" height="1" class="px onb-ring-2" />
    <rect x="9" y="8" width="1" height="1" class="px onb-ring-2" />
    <rect x="9" y="9" width="1" height="1" class="px onb-ring-2" />
    <rect x="10" y="7" width="1" height="1" class="px onb-ring-2" />
    <rect x="10" y="8" width="1" height="1" class="px onb-ring-2" />
    <rect x="11" y="5" width="1" height="1" class="px onb-ring-2" />
    <rect x="11" y="6" width="1" height="1" class="px onb-ring-2" />
    <rect x="11" y="7" width="1" height="1" class="px onb-ring-2" />
    <rect x="12" y="6" width="1" height="1" class="px onb-ring-2" />
    <rect x="9" y="4" width="1" height="1" class="px onb-ring-2" />
    <rect x="10" y="4" width="1" height="1" class="px onb-ring-2" />
    <rect x="10" y="5" width="1" height="1" class="px onb-ring-2" />

    <!-- the torn seam -->
    <rect x="7" y="3" width="1" height="1" class="px onb-shard" />
    <rect x="7" y="4" width="1" height="1" class="px onb-shard" />

    <!-- the loose fleck -->
    <rect x="5" y="9" width="1" height="1" class="px onb-debris" />

    <!-- off-center core, with a dim echo pixel riding beside it -->
    <rect x="8" y="7" width="1" height="1" class="px onb-eye-core" />
    <rect x="9" y="7" width="1" height="1" class="px onb-eye-echo" />
  </g>
</svg>

<style>
  .onb-angel {
    shape-rendering: crispEdges;
    filter: drop-shadow(0 0 2px hsl(var(--background))) drop-shadow(0 0 2px hsl(var(--background)))
      drop-shadow(0 0 5px hsl(var(--background) / 0.75));
  }

  /* Idle: a slow, ambient sway — no rotation, no float glitch (those read as
     "working" on the FAB; here Nulliel is just present). */
  .onb-angel-body {
    animation: onb-sway 9s ease-in-out infinite;
    transform-origin: 6.5px 6.5px;
  }

  .onb-ring-1 {
    fill: hsl(var(--foreground) / 0.7);
    animation: onb-shimmer 6s ease-in-out infinite;
  }
  .onb-ring-2 {
    fill: hsl(var(--foreground) / 0.55);
    animation: onb-shimmer 6s ease-in-out infinite;
    animation-delay: -3s;
  }
  .onb-shard {
    fill: hsl(var(--foreground) / 0.3);
  }
  .onb-debris {
    fill: hsl(var(--foreground) / 0.25);
  }
  .onb-eye-core,
  .onb-eye-echo {
    fill: hsl(var(--destructive, 350 80% 45%));
  }
  .onb-eye-core {
    animation: onb-blink 5.6s ease-in-out infinite;
  }
  .onb-eye-echo {
    fill: hsl(var(--destructive, 350 80% 45%) / 0.4);
    animation: onb-blink 7.1s ease-in-out infinite;
    animation-delay: -1.6s;
  }

  @keyframes onb-sway {
    0%,
    100% {
      transform: rotate(0deg) translateY(0);
    }
    50% {
      transform: rotate(1.5deg) translateY(-1px);
    }
  }

  @keyframes onb-shimmer {
    0%,
    100% {
      opacity: 0.7;
    }
    50% {
      opacity: 0.92;
    }
  }

  @keyframes onb-blink {
    0%,
    90%,
    100% {
      opacity: 1;
    }
    94% {
      opacity: 0.25;
    }
  }

  .onb-angel.reduced .onb-angel-body,
  .onb-angel.reduced .onb-ring-1,
  .onb-angel.reduced .onb-ring-2,
  .onb-angel.reduced .onb-eye-core,
  .onb-angel.reduced .onb-eye-echo {
    animation: none;
  }
</style>
