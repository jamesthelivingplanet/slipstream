<script lang="ts">
  import { icons } from '../../icons'

  const appVersion = __APP_VERSION__
  const appGitHash = __APP_GIT_HASH__
</script>

<div class="tab-header">
  <span class="tab-title">About</span>
</div>

<div class="about-block">
  <div class="about-logo">
    <img src="/icons/icon.svg" alt="Slipstream" class="about-glyph" />
    <div>
      <b>Slipstream</b>
      <p class="about-desc">
        A desktop console for running and watching many Claude Code agents at once.
      </p>
    </div>
  </div>

  <div class="about-links">
    <a
      class="about-row"
      href="https://gitlab.com/ajlebaron/slipstream"
      target="_blank"
      rel="noopener noreferrer"
    >
      <span class="about-label">Repository</span>
      <span class="about-value mono"
        >gitlab.com/ajlebaron/slipstream {@html icons.externalLink}</span
      >
    </a>
    <a
      class="about-row"
      href="https://gitlab.com/ajlebaron/slipstream/-/issues"
      target="_blank"
      rel="noopener noreferrer"
    >
      <span class="about-label">File an issue</span>
      <span class="about-value mono"
        >Report bugs &amp; request features {@html icons.externalLink}</span
      >
    </a>
    <a
      class="about-row"
      href="https://gitlab.com/ajlebaron/slipstream/-/merge_requests"
      target="_blank"
      rel="noopener noreferrer"
    >
      <span class="about-label">Merge requests</span>
      <span class="about-value mono">Contribute code {@html icons.externalLink}</span>
    </a>
  </div>

  <div class="about-version">
    <span class="muted">Version</span>
    <span class="mono">{appVersion}</span>
    <span class="muted">·</span>
    <span class="mono">{appGitHash}</span>
  </div>
</div>

<style>
  .about-block {
    display: flex;
    flex-direction: column;
    gap: 18px;
  }
  .about-logo {
    display: flex;
    gap: 14px;
    align-items: flex-start;
  }
  .about-glyph {
    width: 40px;
    height: 40px;
    border-radius: 10px;
    flex: 0 0 40px;
    object-fit: contain;
  }
  .about-logo b {
    font-size: 15px;
    font-weight: 600;
  }
  .about-desc {
    font-size: 12.5px;
    color: hsl(var(--muted-foreground));
    margin-top: 4px;
    line-height: 1.5;
  }
  .about-links {
    display: flex;
    flex-direction: column;
    gap: 1px;
    border: 1px solid hsl(var(--border));
    border-radius: var(--radius);
    overflow: hidden;
  }
  .about-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 11px 13px;
    background: hsl(var(--card));
    border-bottom: 1px solid hsl(var(--border));
    transition: background 0.12s;
    text-decoration: none;
    color: inherit;
  }
  .about-row:last-child {
    border-bottom: none;
  }
  .about-row:hover {
    background: hsl(var(--card-hover));
  }
  .about-label {
    font-size: 13px;
    font-weight: 500;
  }
  .about-value {
    font-size: 12px;
    color: hsl(var(--primary));
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .about-version {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    padding-top: 4px;
  }
</style>
