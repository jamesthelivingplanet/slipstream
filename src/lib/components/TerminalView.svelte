<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { Terminal, type IDisposable } from '@xterm/xterm'
  import { FitAddon } from '@xterm/addon-fit'
  import { buildScript, C, terminalTheme } from '../term'
  import { repoOf } from '../mock'
  import { mode } from '../theme'
  import { select, resolveNeedsInput } from '../stores'
  import { icons } from '../icons'
  import type { Session } from '../types'

  export let session: Session

  let mountEl: HTMLDivElement
  let term: Terminal
  let fit: FitAddon
  let timer: ReturnType<typeof setTimeout> | null = null
  let askSub: IDisposable | null = null
  let needsInput = false
  let alertMsg = ''

  $: r = repoOf(session.repo)
  $: dot =
    session.status === 'idle'
      ? 'hsl(var(--muted-foreground))'
      : `hsl(var(--st-${session.status === 'needs' ? 'needs' : session.status === 'running' ? 'run' : session.status === 'done' ? 'done' : 'error'}))`

  onMount(() => {
    term = new Terminal({
      fontFamily: "'Geist Mono', monospace", fontSize: 13, lineHeight: 1.5,
      cursorBlink: true, cursorStyle: 'bar', theme: terminalTheme(),
    })
    fit = new FitAddon()
    term.loadAddon(fit)
    term.open(mountEl)
    try { fit.fit() } catch {}
    run()

    const onResize = () => { try { fit.fit() } catch {} }
    window.addEventListener('resize', onResize)
    const unsub = mode.subscribe(() => { if (term) term.options.theme = terminalTheme() })

    return () => { window.removeEventListener('resize', onResize); unsub() }
  })

  onDestroy(() => { cleanup(); term?.dispose() })

  function cleanup() {
    if (timer) { clearTimeout(timer); timer = null }
    if (askSub) { askSub.dispose(); askSub = null }
    needsInput = false
  }

  function run() {
    cleanup()
    term.reset()
    setTimeout(() => { try { fit.fit() } catch {}; term.focus() }, 40)
    if (!r) return
    const lines = buildScript(session, r)
    let i = 0
    const step = () => {
      if (i >= lines.length) return
      const [text, delay, tag] = lines[i++]
      term.writeln(text)
      if (tag === 'ASK') {
        term.write('\r\n' + C.violet('❯ '))
        alertMsg = session.activity.text
        needsInput = true
        bindAsk()
        return
      }
      if (tag === 'SPIN') return
      timer = setTimeout(step, delay)
    }
    step()
  }

  function bindAsk() {
    askSub = term.onData((d) => {
      if (d === '\r') return
      if (d === '1' || d === '2') {
        term.write(d + '\r\n\r\n')
        term.writeln(C.dim('  ↳ ') + (d === '1' ? 'Invalidating sessions on refresh.' : 'Migrating sessions to the new token.'))
        term.writeln('')
        term.writeln(C.blue('● ') + 'Editing ' + C.dim('src/auth/refresh.ts'))
        needsInput = false
        askSub?.dispose()
        askSub = null
        resolveNeedsInput(session.tid)
        setTimeout(() => term.writeln(C.blue('● ') + 'Running tests…'), 900)
      } else {
        term.write(d)
      }
    })
  }
</script>

<div class="term-head">
  <button class="btn btn-ghost btn-icon btn-sm" title="Deselect" on:click={() => select(null)}>
    {@html icons.chevronLeft}
  </button>
  <div class="th-title">
    <div class="t"><span class="stat-dot" style="background:{dot}"></span>{session.tid} · {session.title}</div>
    <div class="m">
      <span class="badge mono">{@html icons.folder} {r?.org}/{r?.name}</span>
      <span class="badge mono">{@html icons.gitBranch} {session.branch}</span>
    </div>
  </div>
  <div class="spacer"></div>
  <button class="btn btn-outline btn-sm" on:click={() => alert('Opens the worktree in your editor (Phase 1)')}>
    {@html icons.externalLink} Editor
  </button>
  <button class="btn btn-outline btn-sm btn-danger" on:click={() => alert('git worktree remove — guarded if dirty/unmerged (Phase 1)')}>
    {@html icons.trash} Clean up
  </button>
</div>

<div class="term-wrap"><div class="term-mount" bind:this={mountEl}></div></div>

{#if needsInput}
  <div class="alert">
    <span class="ic">{@html icons.alert}</span>
    <div class="tx"><b>Agent needs your input</b><span>{alertMsg}</span></div>
    <div class="keys"><span class="kbd">1</span><span class="kbd">2</span><span class="kbd">↵</span></div>
  </div>
{/if}
