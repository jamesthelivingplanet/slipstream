<script lang="ts">
  /**
   * Nulliel loading animation — the app mascot (the transparent
   * `nulliel-glyph.svg`) drifting up and down over a soft breathing glow, with
   * an animated-ellipsis caption, used for the agent create/delete loading
   * screens (TASK-RAHTX) and the queued / fresh-start terminal overlays
   * (FLO-110). `size` scales the glyph (and the glow); `caption` is the line
   * beneath it (and gets the trailing dots).
   *
   * Respects `prefers-reduced-motion`: the float + glow collapse to a gentle
   * opacity breathe so it still reads as "in progress" without motion.
   */
  export let size: number = 56
  export let caption: string | undefined = undefined
</script>

<div class="nulliel-loader" style="--nl-size:{size}px">
  <div class="nl-orb">
    <span class="nl-glow" aria-hidden="true"></span>
    <img src="/icons/nulliel-glyph.svg" alt="" class="nl-glyph" />
  </div>
  {#if caption}<span class="nl-caption">{caption}<span class="nl-dots"></span></span>{/if}
</div>

<style>
  .nulliel-loader {
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    gap: 14px;
  }
  .nl-orb {
    position: relative;
    width: var(--nl-size);
    height: var(--nl-size);
    /* The glyph bobs up to ~12% of its size; keep a little headroom so the
     * drop-shadow / float never clips at the top of a tight container. */
    padding-top: calc(var(--nl-size) * 0.12);
  }
  .nl-glyph {
    position: relative;
    z-index: 1;
    width: var(--nl-size);
    height: var(--nl-size);
    filter: drop-shadow(0 6px 12px hsl(var(--primary) / 0.22));
    animation: nl-float 1.8s ease-in-out infinite;
  }
  /* Soft halo behind the mascot that breathes in place while the glyph bobs —
   * the two animations share a period so the whole thing reads as one pulse. */
  .nl-glow {
    position: absolute;
    left: 0;
    top: calc(var(--nl-size) * 0.12);
    width: var(--nl-size);
    height: var(--nl-size);
    border-radius: 50%;
    background: radial-gradient(circle, hsl(var(--primary) / 0.4) 0%, hsl(var(--primary) / 0) 68%);
    filter: blur(calc(var(--nl-size) / 7));
    animation: nl-glow 1.8s ease-in-out infinite;
  }
  .nl-caption {
    font-size: 13px;
    color: hsl(var(--muted-foreground));
    font-weight: 500;
    letter-spacing: 0.01em;
    animation: fade 0.4s ease-out;
  }
  /* Trailing ellipsis animates 0 → 1 → 2 → 3 dots so the caption reads as
   * "loading…" without a JS timer. */
  .nl-dots::after {
    content: '';
    animation: nl-dots 1.4s steps(1, end) infinite;
  }
  @keyframes nl-float {
    0%,
    100% {
      transform: translateY(0) scale(1);
    }
    50% {
      transform: translateY(calc(var(--nl-size) * -0.12)) scale(1.04);
    }
  }
  @keyframes nl-glow {
    0%,
    100% {
      opacity: 0.5;
      transform: scale(0.9);
    }
    50% {
      opacity: 0.95;
      transform: scale(1.08);
    }
  }
  @keyframes nl-dots {
    0% {
      content: '';
    }
    25% {
      content: '.';
    }
    50% {
      content: '..';
    }
    75%,
    100% {
      content: '...';
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .nl-glyph {
      animation: nl-breathe 1.8s ease-in-out infinite;
    }
    .nl-glow {
      animation: none;
      opacity: 0.7;
    }
    .nl-dots::after {
      animation: none;
      content: '...';
    }
  }
  @keyframes nl-breathe {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.5;
    }
  }
</style>
