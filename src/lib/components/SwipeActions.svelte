<script lang="ts">
  /**
   * SwipeActions — swipe-to-reveal action wrapper for a list row/card.
   *
   * Wraps a foreground element (the row, default slot) in a positioned
   * container with two absolutely-positioned action panels behind it
   * (`left`/`right` named slots). A horizontal pointer drag slides the
   * foreground aside to reveal the panel on the opposite side; a tap (no
   * horizontal travel) falls through to the foreground's own click.
   *
   * Mobile-only by design: when `enabled` is false the default slot renders
   * bare (no wrapper, no handlers) so desktop layout/click behavior is
   * byte-for-byte unchanged.
   *
   * Single-open coordination: the parent owns `openId` (which row is open).
   * When a drag settles open this dispatches `open` so the parent can point
   * `openId` here (closing every other row); when the parent moves `openId`
   * away this row snaps shut. Pure gesture math lives in ../swipe.js.
   */
  import { createEventDispatcher } from 'svelte'
  import {
    swipeAxis,
    clampSwipeOffset,
    swipeSettle,
    swipeTargetOffset,
    type SwipeSide,
  } from '../swipe.js'

  export let id: string
  export let openId: string | null = null
  export let enabled = true

  const dispatch = createEventDispatcher<{
    open: { id: string; side: Exclude<SwipeSide, null> }
    close: { id: string }
  }>()

  let fgEl: HTMLElement
  let leftEl: HTMLElement
  let rightEl: HTMLElement
  let leftWidth = 0
  let rightWidth = 0

  // Current translateX of the foreground. Positive = shifted right (revealing
  // the left panel); negative = shifted left (revealing the right panel).
  let offset = 0
  let dragging = false
  let axis: 'horizontal' | 'vertical' | null = null
  let startX = 0
  let startY = 0
  let startOffset = 0
  let lastX = 0
  let lastT = 0
  let velocity = 0
  // True between pointerup and the synthesized click that follows a real
  // horizontal drag — that click is suppressed so the drag never also fires
  // the row's navigate handler.
  let suppressClick = false

  // The rows/cards have semi-transparent backgrounds, so a panel sitting
  // behind the foreground would bleed through when closed. Each panel is only
  // opaque/tappable while its side is actually being revealed (offset sign).
  $: leftRevealed = offset > 0
  $: rightRevealed = offset < 0
  $: fgTransition = dragging ? 'none' : 'transform 0.2s ease'
  $: panelTransition = dragging ? 'opacity 0s' : 'opacity 0.14s ease'

  /** Settle the foreground to a side and notify the parent of the new state. */
  function settle(side: SwipeSide) {
    offset = swipeTargetOffset(side, leftWidth, rightWidth)
    if (side) dispatch('open', { id, side })
    else dispatch('close', { id })
  }

  function onPointerDown(e: PointerEvent) {
    if (!enabled) return
    // Left button only for mouse; touch/pen always count.
    if (e.pointerType === 'mouse' && e.button !== 0) return
    dragging = true
    axis = null
    suppressClick = false
    startX = e.clientX
    startY = e.clientY
    startOffset = offset
    lastX = e.clientX
    lastT = e.timeStamp
    velocity = 0
    try {
      fgEl.setPointerCapture(e.pointerId)
    } catch {
      /* pointer capture is best-effort; dragging still works without it */
    }
  }

  function onPointerMove(e: PointerEvent) {
    if (!dragging) return
    const dx = e.clientX - startX
    const dy = e.clientY - startY
    if (axis === null) {
      const locked = swipeAxis(dx, dy)
      if (locked === null) return
      if (locked === 'vertical') {
        // A vertical pan is a page scroll — abandon so the browser handles it.
        dragging = false
        return
      }
      axis = 'horizontal'
    }
    // Horizontal: follow the finger, clamped to the reachable range. Only a
    // side with a slotted action panel can be revealed (width > 0).
    offset = clampSwipeOffset(startOffset + dx, leftWidth, rightWidth)
    const dt = e.timeStamp - lastT
    if (dt > 0) velocity = (e.clientX - lastX) / dt
    lastX = e.clientX
    lastT = e.timeStamp
    // Stop text selection / scroll chaining for the horizontal pan; vertical
    // scrolling is already handed off via the `vertical` abandon + pan-y.
    e.preventDefault()
  }

  function endDrag(e: PointerEvent, cancelled: boolean) {
    if (!dragging) return
    dragging = false
    try {
      fgEl.releasePointerCapture(e.pointerId)
    } catch {
      /* already released */
    }
    if (cancelled || axis !== 'horizontal') {
      // Tap or cancelled/vertical gesture: leave the offset where the last
      // settle put it (a tap on an open row is closed by the click guard).
      return
    }
    suppressClick = true
    settle(swipeSettle(offset, leftWidth, rightWidth, velocity))
  }

  function onPointerUp(e: PointerEvent) {
    endDrag(e, false)
  }

  function onPointerCancel(e: PointerEvent) {
    endDrag(e, true)
  }

  // Capture-phase click guard on the container. Runs BEFORE the foreground
  // button's own click, so it can swallow a click that should NOT navigate:
  //  - the synthetic click right after a horizontal drag (suppressClick)
  //  - any tap on an already-open row's foreground (close instead of navigate)
  // Clicks on the revealed action buttons (outside the foreground) pass through.
  function onClickCapture(e: MouseEvent) {
    if (!enabled) return
    const target = e.target as HTMLElement | null
    if (!target || !fgEl.contains(target)) return // an action button — let it through
    if (suppressClick) {
      e.stopPropagation()
      e.preventDefault()
      suppressClick = false
      return
    }
    if (offset !== 0) {
      e.stopPropagation()
      e.preventDefault()
      settle(null)
    }
  }

  // Parent-driven close: when another row opens (openId moves away) or the
  // parent clears openId (e.g. after an action fired), snap this row shut.
  $: if (enabled && openId !== id && offset !== 0) settle(null)

  /** Programmatic close, callable from the parent via bind:this. */
  export function close() {
    if (offset !== 0) settle(null)
  }
</script>

{#if enabled}
  <div class="swipe" on:click|capture={onClickCapture} role="presentation">
    {#if $$slots.left}
      <div
        class="swipe-actions left"
        class:revealed={leftRevealed}
        style="transition: {panelTransition};"
        bind:this={leftEl}
        bind:clientWidth={leftWidth}
      >
        <slot name="left" />
      </div>
    {/if}
    {#if $$slots.right}
      <div
        class="swipe-actions right"
        class:revealed={rightRevealed}
        style="transition: {panelTransition};"
        bind:this={rightEl}
        bind:clientWidth={rightWidth}
      >
        <slot name="right" />
      </div>
    {/if}
    <!-- The foreground slides; panels stay put behind it. Pointer handlers
         live on the foreground so a drag starting on a revealed action button
         (only reachable when open) doesn't initiate a swipe. -->
    <div
      class="swipe-fg"
      bind:this={fgEl}
      style="transform: translateX({offset}px); transition: {fgTransition};"
      on:pointerdown={onPointerDown}
      on:pointermove={onPointerMove}
      on:pointerup={onPointerUp}
      on:pointercancel={onPointerCancel}
    >
      <slot />
    </div>
  </div>
{:else}
  <slot />
{/if}

<style>
  .swipe {
    position: relative;
    /* Clip revealed action buttons to the row's rounded corners. (Card glow
       is clipped on mobile too — a 3px / 6%-alpha halo, imperceptible.) */
    overflow: hidden;
    border-radius: var(--radius);
  }

  /* Revealed action panels sit behind the foreground, each pinned to an edge
     and sized to its buttons (the foreground translates by that width). They
     start fully transparent + click-through so they can't bleed through the
     semi-transparent row when closed, and fade in only as their side opens. */
  .swipe-actions {
    position: absolute;
    top: 0;
    bottom: 0;
    z-index: 1;
    display: flex;
    align-items: stretch;
    opacity: 0;
    pointer-events: none;
    overflow: hidden;
  }
  .swipe-actions.revealed {
    opacity: 1;
    pointer-events: auto;
  }
  .swipe-actions.left {
    left: 0;
    border-radius: var(--radius) 0 0 var(--radius);
  }
  .swipe-actions.right {
    right: 0;
    border-radius: 0 var(--radius) var(--radius) 0;
  }

  .swipe-fg {
    position: relative;
    z-index: 2;
    /* pan-y lets the page scroll on a vertical pan; horizontal pans come
       through as pointer events for us to translate, so a horizontal swipe
       never yanks the list. */
    touch-action: pan-y;
    will-change: transform;
  }
  .swipe-fg :global(*) {
    /* A drag shouldn't kick off a text/image selection mid-swipe. */
    -webkit-user-select: none;
    user-select: none;
  }
</style>
