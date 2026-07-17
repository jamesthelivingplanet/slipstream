<script lang="ts">
  // Full-screen first-boot onboarding pager, shown only inside the Capacitor
  // mobile shell (see onboardingMode() in ../onboarding.ts — App.svelte picks
  // this component vs. OnboardingModal.svelte based on that). Self-gates on
  // $onboardingVisible, same convention as NewAgentDialog/SettingsModal
  // (`{#if $store}` around an always-`open` panel) rather than App.svelte
  // conditionally mounting/unmounting it.
  import { fade } from 'svelte/transition'
  import { onboardingVisible, markOnboardingSeen } from '../onboarding'
  import { ONBOARDING_SCREENS, MASCOT_NAME } from '../onboardingContent'
  import { enableNativePush } from '../push'
  import OnboardingAngel from './OnboardingAngel.svelte'

  const screens = ONBOARDING_SCREENS
  const NOTIF_SCREEN_ID = 'notifications'

  let index = 0
  let reducedMotion = false
  if (typeof matchMedia === 'function') {
    reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches
  }

  $: screen = screens[index]
  $: isLast = index === screens.length - 1
  $: isNotifScreen = screen.id === NOTIF_SCREEN_ID

  type NotifStatus = 'idle' | 'enabling' | 'enabled' | 'unavailable'
  let notifStatus: NotifStatus = 'idle'

  function goTo(next: number) {
    index = Math.max(0, Math.min(screens.length - 1, next))
  }
  function next() {
    if (isLast) {
      finish()
      return
    }
    goTo(index + 1)
  }
  function prev() {
    goTo(index - 1)
  }
  function skip() {
    markOnboardingSeen()
  }
  function finish() {
    markOnboardingSeen()
  }

  // Guarded per the brief: a rejected permission, an old APK predating the
  // PushNotifications plugin, or any thrown error all fall through to the
  // same "enable it later" hint rather than surfacing an error state — this
  // is a first-boot tour, not the place to relitigate push failures (that's
  // Settings → Notifications, SettingsNotifications.svelte, which reuses the
  // same enableNativePush()).
  async function handleEnableNotifications() {
    notifStatus = 'enabling'
    try {
      const result = await enableNativePush()
      notifStatus = result.ok ? 'enabled' : 'unavailable'
    } catch {
      notifStatus = 'unavailable'
    }
  }

  function handleNotNow() {
    next()
  }

  // Swipe: a horizontal pointer drag on the stage (not the footer buttons)
  // advances/retreats a screen past a threshold, snapping back otherwise.
  const SWIPE_THRESHOLD_PX = 60
  let dragging = false
  let dragStartX = 0
  let dragDeltaX = 0

  function pointerDown(e: PointerEvent) {
    dragging = true
    dragStartX = e.clientX
    dragDeltaX = 0
  }
  function pointerMove(e: PointerEvent) {
    if (!dragging) return
    dragDeltaX = e.clientX - dragStartX
  }
  function pointerUp() {
    if (!dragging) return
    dragging = false
    if (dragDeltaX <= -SWIPE_THRESHOLD_PX) next()
    else if (dragDeltaX >= SWIPE_THRESHOLD_PX) prev()
    dragDeltaX = 0
  }
</script>

{#if $onboardingVisible}
  <div class="onb-overlay" role="dialog" aria-modal="true" aria-label="Welcome to Slipstream">
    <button type="button" class="onb-skip" on:click={skip}>Skip</button>

    <div
      class="onb-stage"
      style={dragging
        ? `transform: translateX(${dragDeltaX}px); transition: none`
        : reducedMotion
          ? 'transition: none'
          : ''}
      on:pointerdown={pointerDown}
      on:pointermove={pointerMove}
      on:pointerup={pointerUp}
      on:pointercancel={pointerUp}
    >
      <div class="onb-angel-wrap">
        <OnboardingAngel size={104} />
      </div>

      {#key screen.id}
        <div class="onb-bubble" transition:fade={{ duration: reducedMotion ? 0 : 160 }}>
          <span class="onb-nameplate">{MASCOT_NAME.toUpperCase()}</span>
          <h2 class="onb-title">{screen.title}</h2>
          <p class="onb-line">{screen.line}</p>
          {#if screen.bullets}
            <ul class="onb-bullets">
              {#each screen.bullets as b (b)}
                <li>{b}</li>
              {/each}
            </ul>
          {/if}

          {#if isNotifScreen}
            <div class="onb-notif-actions">
              <button
                type="button"
                class="btn btn-primary btn-sm"
                on:click={handleEnableNotifications}
                disabled={notifStatus === 'enabling' || notifStatus === 'enabled'}
              >
                {notifStatus === 'enabled' ? 'Notifications on' : 'Enable notifications'}
              </button>
              <button type="button" class="btn btn-ghost btn-sm" on:click={handleNotNow}>
                Not now
              </button>
            </div>
            {#if notifStatus === 'unavailable'}
              <p class="onb-hint">You can enable this later in Settings → Notifications.</p>
            {/if}
          {/if}

          <span class="onb-bubble-pointer" aria-hidden="true"></span>
        </div>
      {/key}
    </div>

    <div class="onb-footer">
      <div class="onb-dots" aria-hidden="true">
        {#each screens as s, i (s.id)}
          <span class="onb-dot" class:active={i === index}></span>
        {/each}
      </div>
      <div class="onb-nav">
        {#if index > 0}
          <button type="button" class="btn btn-ghost btn-sm" on:click={prev}>Back</button>
        {/if}
        <button type="button" class="btn btn-primary btn-sm" on:click={next}>
          {isLast ? 'Get started' : 'Next'}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  /* Above every dialog/settings overlay (z-index 50/51) so onboarding can
     never be fought by them; below Toasts (200) so a critical connection
     toast can still surface. */
  .onb-overlay {
    position: fixed;
    inset: 0;
    z-index: 120;
    background: hsl(var(--background));
    display: flex;
    flex-direction: column;
    padding: max(20px, env(safe-area-inset-top)) max(20px, env(safe-area-inset-right))
      max(16px, env(safe-area-inset-bottom)) max(20px, env(safe-area-inset-left));
    animation: onb-fade 0.22s ease both;
  }

  @media (prefers-reduced-motion: reduce) {
    .onb-overlay {
      animation: none;
    }
  }

  @keyframes onb-fade {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  .onb-skip {
    align-self: flex-end;
    background: transparent;
    border: none;
    color: hsl(var(--muted-foreground));
    font-size: 13px;
    font-weight: 500;
    padding: 8px 10px;
    cursor: pointer;
    min-height: 44px;
  }
  .onb-skip:hover {
    color: hsl(var(--foreground));
  }
  .onb-skip:focus-visible {
    outline: 2px solid hsl(var(--ring));
    outline-offset: 2px;
  }

  .onb-stage {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 22px;
    touch-action: pan-y;
    transition: transform 0.18s ease-out;
    min-height: 0;
    overflow-y: auto;
  }

  .onb-angel-wrap {
    flex: 0 0 auto;
  }

  /* Pixel-bordered speech bubble — same visual language as .fab-tip in
     NewAgentFab.svelte (crisp border, offset hard shadow, no radius) scaled
     up for a full-screen context. */
  .onb-bubble {
    position: relative;
    width: min(360px, 100%);
    background: hsl(var(--popover));
    color: hsl(var(--foreground));
    border: 2px solid hsl(var(--border));
    box-shadow: 5px 5px 0 0 hsl(var(--foreground) / 0.16);
    padding: 16px 18px 18px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .onb-nameplate {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    color: hsl(var(--muted-foreground));
  }

  .onb-title {
    font-size: 17px;
    font-weight: 600;
    margin: 0;
  }

  .onb-line {
    margin: 0;
    font-size: 14px;
    line-height: 1.5;
  }

  .onb-bullets {
    margin: 2px 0 0;
    padding-left: 18px;
    display: flex;
    flex-direction: column;
    gap: 5px;
    font-size: 13px;
    line-height: 1.45;
    color: hsl(var(--foreground) / 0.9);
  }

  .onb-notif-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 4px;
  }

  .onb-hint {
    margin: 2px 0 0;
    font-size: 12px;
    color: hsl(var(--muted-foreground));
  }

  .onb-bubble-pointer {
    position: absolute;
    top: -8px;
    left: 50%;
    transform: translateX(-50%) rotate(45deg);
    width: 12px;
    height: 12px;
    background: hsl(var(--popover));
    border-left: 2px solid hsl(var(--border));
    border-top: 2px solid hsl(var(--border));
  }

  .onb-footer {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 14px;
    padding-top: 12px;
  }

  .onb-dots {
    display: flex;
    gap: 8px;
  }

  .onb-dot {
    width: 7px;
    height: 7px;
    background: hsl(var(--border));
    border: 1px solid hsl(var(--border));
  }
  .onb-dot.active {
    background: hsl(var(--primary));
    border-color: hsl(var(--primary));
  }

  .onb-nav {
    display: flex;
    gap: 10px;
  }
</style>
