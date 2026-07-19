<script lang="ts">
  /**
   * Nulliel loading animation — the app mascot (the transparent
   * `nulliel-glyph.svg`) drifting up and down with an animated ellipsis, used
   * for the agent create/delete loading screens (TASK-RAHTX). `size` scales the
   * glyph; `caption` is the line beneath it (and gets the trailing dots).
   *
   * Respects `prefers-reduced-motion`: the float collapses to a gentle opacity
   * breathe so it still reads as \"in progress\" without motion.
   */
  export let size: number = 56
  export let caption: string | undefined = undefined
</script>

<div class="nulliel-loader" style="--nl-size:{size}px">
  <img src="/icons/nulliel-glyph.svg" alt="" class="nl-glyph" />
  {#if caption}<span class="nl-caption">{caption}<span class="nl-dots"></span></span>{/if}
</div>

<style>
  .nulliel-loader {
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
  }
  .nl-glyph {
    width: var(--nl-size);
    height: var(--nl-size);
    filter: drop-shadow(0 6px 10px hsl(var(--primary) / 0.18));
    animation: nl-float 1.8s ease-in-out infinite;
  }
  .nl-caption {
    font-size: 13px;
    color: hsl(var(--muted-foreground));
    font-weight: 500;
  }
  /* Trailing ellipsis animates 0 → 1 → 2 → 3 dots so the caption reads as
   * \"loading…\" without a JS timer. */
  .nl-dots::after {
    content: '';
    animation: nl-dots 1.4s steps(1, end) infinite;
  }
  @keyframes nl-float {
    0%,
    100% {
      transform: translateY(0);
    }
    50% {
      transform: translateY(-7px);
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
