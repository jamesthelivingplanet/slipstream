<script lang="ts">
  // First-boot onboarding modal for web/desktop (plain browser, installed PWA,
  // Electron renderer — everywhere onboardingMode() isn't 'pager'). Reuses
  // ResponsivePanel exactly like NewAgentDialog/SettingsModal/ConfirmDialog,
  // so it gets the same mobile-drawer/desktop-dialog split and styling for
  // free on narrow web viewports too.
  import { mobile } from '../stores'
  import { onboardingVisible, markOnboardingSeen } from '../onboarding'
  import { MASCOT_NAME, ONBOARDING_SCREENS, ONBOARDING_MODAL_BULLETS } from '../onboardingContent'
  import ResponsivePanel from './ResponsivePanel.svelte'
  import OnboardingAngel from './OnboardingAngel.svelte'

  const intro = ONBOARDING_SCREENS[0]

  function finish() {
    markOnboardingSeen()
  }

  // Esc dismiss, matching ConfirmDialog.svelte's pattern (ResponsivePanel
  // itself only wires the backdrop click, not the keyboard).
  function onKeydown(e: KeyboardEvent) {
    if ($onboardingVisible && e.key === 'Escape') finish()
  }
</script>

<svelte:window on:keydown={onKeydown} />

{#if $onboardingVisible}
  <ResponsivePanel open mobile={$mobile} onClose={finish} dialogClass="onboarding-dialog">
    <svelte:fragment slot="header">
      <h2>Meet {MASCOT_NAME}</h2>
    </svelte:fragment>

    <div class="dlg-body onb-modal-body">
      <div class="onb-modal-angel">
        <OnboardingAngel size={72} />
      </div>
      <div class="onb-modal-bubble">
        <span class="onb-modal-nameplate">{MASCOT_NAME.toUpperCase()}</span>
        <p class="onb-modal-line">{intro.line}</p>
      </div>
      <ul class="onb-modal-bullets">
        {#each ONBOARDING_MODAL_BULLETS as b (b)}
          <li>{b}</li>
        {/each}
      </ul>
    </div>

    <svelte:fragment slot="footer">
      <button type="button" class="btn btn-primary" on:click={finish}>Let's go</button>
    </svelte:fragment>
  </ResponsivePanel>
{/if}

<style>
  .onb-modal-body {
    align-items: center;
    text-align: center;
  }

  .onb-modal-angel {
    display: flex;
    justify-content: center;
  }

  /* Same pixel-bordered speech-bubble language as .fab-tip / OnboardingPager's
     bubble, sized down for the dialog body. */
  .onb-modal-bubble {
    align-self: stretch;
    background: hsl(var(--muted) / 0.4);
    border: 2px solid hsl(var(--border));
    padding: 12px 14px;
    text-align: left;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .onb-modal-nameplate {
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.08em;
    color: hsl(var(--muted-foreground));
  }

  .onb-modal-line {
    margin: 0;
    font-size: 13.5px;
    line-height: 1.5;
    color: hsl(var(--foreground));
  }

  .onb-modal-bullets {
    align-self: stretch;
    text-align: left;
    margin: 0;
    padding-left: 20px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 13px;
    line-height: 1.5;
    color: hsl(var(--foreground) / 0.9);
  }
</style>
