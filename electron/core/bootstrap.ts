/**
 * bootstrap.ts — orchestrates app boot (resolve daemon config → ensure local
 * daemon → show app), surfacing failures instead of booting a poisoned window.
 *
 * Node builtins only (no electron, no native modules) so unit tests run in
 * plain node.
 */
import type { DaemonConfig, DaemonHandle } from './daemonManager.js'

export type BootStage = 'resolve-config' | 'ensure-daemon'

export type BootOutcome =
  { ok: true; config: DaemonConfig } | { ok: false; stage: BootStage; error: unknown }

export interface BootstrapDeps {
  resolveConfig(): Promise<DaemonConfig>
  ensureDaemon(cfg: DaemonConfig): Promise<DaemonHandle>
  showApp(cfg: DaemonConfig): void
  showError(outcome: Extract<BootOutcome, { ok: false }>): void
}

export async function runBootstrap(deps: BootstrapDeps): Promise<BootOutcome> {
  let cfg: DaemonConfig
  try {
    cfg = await deps.resolveConfig()
  } catch (err) {
    const outcome = { ok: false, stage: 'resolve-config', error: err } as const
    deps.showError(outcome)
    return outcome
  }

  if (cfg.mode === 'local') {
    try {
      await deps.ensureDaemon(cfg)
    } catch (err) {
      const outcome = { ok: false, stage: 'ensure-daemon', error: err } as const
      deps.showError(outcome)
      return outcome
    }
  }

  deps.showApp(cfg)
  return { ok: true, config: cfg }
}

export function daemonErrorMessage(stage: BootStage): string {
  switch (stage) {
    case 'resolve-config':
      return 'Slipstream could not resolve its daemon configuration.'
    case 'ensure-daemon':
      return 'Slipstream could not start its local daemon.'
  }
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function renderDaemonErrorPage(outcome: Extract<BootOutcome, { ok: false }>): string {
  const stageMessage = daemonErrorMessage(outcome.stage)
  const errText = outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
  const safeStageMessage = escapeHtml(stageMessage)
  const safeErrText = escapeHtml(errText)

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Slipstream couldn't start</title>
<style>
  :root {
    color-scheme: dark;
  }
  * {
    box-sizing: border-box;
  }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #09090b;
    color: #fafafa;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial,
      sans-serif;
  }
  .wrap {
    max-width: 640px;
    padding: 48px;
  }
  h1 {
    color: #ef4444;
    font-size: 1.5rem;
    margin: 0 0 12px;
  }
  p {
    line-height: 1.5;
  }
  .muted {
    color: #a1a1aa;
  }
  pre {
    background: #18181b;
    border: 1px solid #27272a;
    border-radius: 8px;
    padding: 16px;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-word;
    color: #fafafa;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.85rem;
  }
  h2 {
    font-size: 1rem;
    margin: 24px 0 8px;
    color: #fafafa;
  }
  ol {
    color: #a1a1aa;
    line-height: 1.6;
    padding-left: 20px;
  }
  code {
    background: #18181b;
    border-radius: 4px;
    padding: 2px 6px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
</style>
</head>
<body>
  <div class="wrap">
    <h1>Slipstream couldn't start</h1>
    <p class="muted">${safeStageMessage}</p>
    <pre>${safeErrText}</pre>
    <h2>What to try</h2>
    <ol>
      <li>Re-run setup: <code>scripts/setup.sh</code></li>
      <li>Check the daemon logs at <code>&lt;data dir&gt;/logs/server.log</code></li>
      <li>See the "Troubleshooting native setup" section in <code>CLAUDE.md</code></li>
    </ol>
  </div>
</body>
</html>
`
}
