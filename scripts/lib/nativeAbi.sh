#!/usr/bin/env bash
# nativeAbi.sh — native-module ABI check + rebuild for a repo checkout.
# Sourced, not executed; functions only, no top-level side effects. Mirrors
# the style of scripts/lib/target.sh.
#
# better-sqlite3 and node-pty are native modules compiled against a specific
# Node/Electron ABI (see docs/NATIVE-MODULES.md). `pnpm install` in ANY
# checkout (main or a linked worktree) builds them against plain Node's ABI;
# only `pnpm setup`'s explicit `@electron/rebuild --force` step (or this
# file's slipstream_native_rebuild) rebuilds them against Electron's ABI,
# which is what the daemon actually runs under. A worktree that only ever ran
# `pnpm install` (never `pnpm setup`) has ABI-mismatched native modules and
# will crash-loop in openDb() with ERR_DLOPEN_FAILED.
#
# Note: require()-ing better-sqlite3 alone does NOT exercise this — its
# native binding is loaded lazily inside `new Database()`, not at require
# time (see bindings.js / lib/database.js). node-pty's native binding, by
# contrast, IS loaded eagerly at require time (lib/unixTerminal.js). So the
# check below must actually construct a Database to be a real test.

# ---------------------------------------------------------------------------
# slipstream_native_abi_ok <repo_root> — returns 0 if this repo's native
# modules (better-sqlite3, node-pty) load under ELECTRON's ABI, 1 otherwise
# (including when the repo's own electron binary is missing).
#
# Implemented by actually attempting the load — under
# ELECTRON_RUN_AS_NODE=1 (Electron's Node binary, Electron's ABI, no GUI/
# display needed) — rather than by parsing NODE_MODULE_VERSION numbers out of
# the .node binaries, so it can never drift from what the daemon itself does
# at startup (dev-serve.sh execs this same electron binary the same way).
# ---------------------------------------------------------------------------
slipstream_native_abi_ok() {
  local repo_root="$1"
  local electron_bin="${repo_root}/node_modules/electron/dist/electron"

  if [[ ! -x "$electron_bin" ]]; then
    return 1
  fi

  local check_js='
try {
  var dbPath = require.resolve("better-sqlite3", { paths: [process.argv[1]] });
  var Database = require(dbPath);
  var db = new Database(":memory:");
  db.close();
  var ptyPath = require.resolve("node-pty", { paths: [process.argv[1]] });
  require(ptyPath);
  process.exit(0);
} catch (e) {
  process.exit(1);
}
'

  ELECTRON_RUN_AS_NODE=1 "$electron_bin" -e "$check_js" "$repo_root" >/dev/null 2>&1
}

# ---------------------------------------------------------------------------
# slipstream_native_rebuild <repo_root> — rebuilds better-sqlite3 and
# node-pty for Electron's ABI (same command 'pnpm setup' runs for the main
# checkout), under Node 22 for build-tool compatibility. Returns the
# rebuild's exit code. Slow (minutes) the first time it actually compiles;
# fast on a re-run once the ABI already matches.
# ---------------------------------------------------------------------------
slipstream_native_rebuild() {
  local repo_root="$1"
  local lib_dir
  lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

  # shellcheck source=node22.sh
  source "${lib_dir}/node22.sh"

  ( cd "$repo_root" && with_node22 pnpm dlx @electron/rebuild --force --only better-sqlite3,node-pty )
}
