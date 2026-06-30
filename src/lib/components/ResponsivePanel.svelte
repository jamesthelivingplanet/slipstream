<script lang="ts">
  import { shouldDismissDrawer } from '../responsive'

  export let open = false
  export let onClose: () => void = () => {}
  export let mobile = false
  export let dialogClass = ''

  let dragY = 0
  let dragging = false
  let startY = 0

  function grabStart(e: PointerEvent) {
    dragging = true
    startY = e.clientY
    dragY = 0
  }
  function grabMove(e: PointerEvent) {
    if (!dragging) return
    dragY = Math.max(0, e.clientY - startY)
  }
  function grabEnd() {
    if (!dragging) return
    dragging = false
    const dismiss = shouldDismissDrawer(dragY)
    dragY = 0
    if (dismiss) onClose()
  }
</script>

{#if open}
  {#if mobile}
    <div class="drawer-overlay" on:click={onClose} role="presentation"></div>
    <div
      class="drawer"
      style="transform: translateY({dragY}px); transition: {dragging ? 'none' : 'transform .26s cubic-bezier(.2,.8,.2,1)'}"
    >
      <div
        class="drawer-grab"
        role="button"
        tabindex="-1"
        aria-label="Drag down to dismiss"
        on:pointerdown={grabStart}
        on:pointermove={grabMove}
        on:pointerup={grabEnd}
        on:pointercancel={grabEnd}
      >
        <div class="drawer-handle"></div>
      </div>
      <div class="dlg-head"><slot name="header" /></div>
      <div class="drawer-scroll"><slot /></div>
      {#if $$slots.footer}
        <div class="dlg-foot"><slot name="footer" /></div>
      {/if}
    </div>
  {:else}
    <div class="overlay" on:click={onClose} role="presentation"></div>
    <div class="dialog {dialogClass}">
      <div class="dlg-head"><slot name="header" /></div>
      <slot />
      {#if $$slots.footer}
        <div class="dlg-foot"><slot name="footer" /></div>
      {/if}
    </div>
  {/if}
{/if}

<style>
  .drawer-overlay {
    position: fixed;
    inset: 0;
    z-index: 50;
    background: rgba(0, 0, 0, 0.55);
    backdrop-filter: blur(2px);
    animation: drawerFade .2s;
  }
  .drawer {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 51;
    max-height: 92vh;
    display: flex;
    flex-direction: column;
    background: hsl(var(--popover));
    border: 1px solid hsl(var(--border));
    border-bottom: none;
    border-radius: calc(var(--radius) + 6px) calc(var(--radius) + 6px) 0 0;
    box-shadow: var(--shadow);
    animation: drawerUp .26s cubic-bezier(.2,.8,.2,1);
    padding-bottom: env(safe-area-inset-bottom);
  }
  .drawer-grab {
    flex: 0 0 auto;
    padding: 10px 0 4px;
    display: flex;
    justify-content: center;
    cursor: grab;
    touch-action: none;
  }
  .drawer-grab:active { cursor: grabbing; }
  .drawer-handle {
    width: 36px;
    height: 5px;
    border-radius: 99px;
    background: hsl(var(--muted-foreground) / 0.35);
  }
  .drawer-scroll {
    flex: 1;
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .drawer-scroll :global(.dlg-body) {
    overflow: visible;
    padding: 16px 18px;
  }
  @keyframes drawerFade { from { opacity: 0; } to { opacity: 1; } }
  @keyframes drawerUp {
    from { transform: translateY(100%); }
    to { transform: translateY(0); }
  }
</style>
