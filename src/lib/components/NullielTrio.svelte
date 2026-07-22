<script lang="ts">
  /**
   * Three small Nulliel glyphs bouncing in a staggered wave — a typing/activity
   * indicator used in place of the plain breathing status dot for
   * `status === 'running'` agent rows (see AgentList.svelte). Modeled on
   * NullielLoader.svelte's conventions: pure CSS `@keyframes`, no JS timers.
   *
   * Respects `prefers-reduced-motion`: the bounce collapses to a staggered
   * opacity breathe so it still reads as "in progress" without motion.
   */
  export let size: number = 10
</script>

<span class="nulliel-trio" style="--nt-size:{size}px">
  <img src="/icons/nulliel-glyph.svg" alt="" class="nt-glyph nt-1" />
  <img src="/icons/nulliel-glyph.svg" alt="" class="nt-glyph nt-2" />
  <img src="/icons/nulliel-glyph.svg" alt="" class="nt-glyph nt-3" />
</span>

<style>
  .nulliel-trio {
    display: inline-flex;
    align-items: center;
    gap: 2px;
  }
  .nt-glyph {
    width: var(--nt-size);
    height: var(--nt-size);
    animation: nt-bounce 0.9s ease-in-out infinite;
  }
  .nt-1 {
    animation-delay: 0s;
  }
  .nt-2 {
    animation-delay: 0.15s;
  }
  .nt-3 {
    animation-delay: 0.3s;
  }
  @keyframes nt-bounce {
    0%,
    100% {
      transform: translateY(0);
    }
    50% {
      transform: translateY(-4px);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .nt-glyph {
      animation: nt-breathe 1.8s ease-in-out infinite;
    }
    .nt-1 {
      animation-delay: 0s;
    }
    .nt-2 {
      animation-delay: 0.2s;
    }
    .nt-3 {
      animation-delay: 0.4s;
    }
  }
  @keyframes nt-breathe {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.45;
    }
  }
</style>
