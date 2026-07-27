#!/usr/bin/env bash
# target.sh — deploy-target resolution (dev vs prod). Sourced, not executed;
# functions only, no top-level side effects.
#
# A linked git worktree (e.g. one of the per-ticket worktrees under
# .claude/worktrees/) must only ever be able to deploy to its own isolated
# "dev" instance — never to the shared production instance. That guard lives
# in scripts/deploy.sh; the functions here just answer "which checkout is
# this" structurally, without any path matching, so it can't be fooled by a
# clone living somewhere unexpected.

# ---------------------------------------------------------------------------
# slipstream_is_linked_worktree — 0 (true) when the current checkout is a
# LINKED git worktree (created via `git worktree add`), 1 (false) when it is
# the main worktree (or git metadata can't be read at all).
#
# Structural, not path-based: `git rev-parse --absolute-git-dir` for a linked
# worktree lives under <common-dir>/worktrees/<name>; for the main worktree
# it IS the common dir. So: linked iff absolute-git-dir != absolute
# git-common-dir.
# ---------------------------------------------------------------------------
slipstream_is_linked_worktree() {
  local git_dir common_dir_raw common_dir
  git_dir="$(git rev-parse --absolute-git-dir 2>/dev/null)" || return 1
  common_dir_raw="$(git rev-parse --git-common-dir 2>/dev/null)" || return 1
  # --git-common-dir may be printed relative to the cwd; normalize to
  # absolute so the comparison below is exact either way.
  common_dir="$(cd "$common_dir_raw" 2>/dev/null && pwd)" || return 1

  [[ "$git_dir" != "$common_dir" ]]
}

# ---------------------------------------------------------------------------
# slipstream_worktree_slug — echoes a systemd-safe slug for the current
# checkout: basename of the repo root, with every character outside
# [A-Za-z0-9_.-] replaced by '-'. Mirrors slugForRoot() in
# scripts/lib/devSlots.mjs — keep the two in sync.
# ---------------------------------------------------------------------------
slipstream_worktree_slug() {
  local root base
  root="$(git rev-parse --show-toplevel 2>/dev/null)" || return 1
  base="$(basename "$root")"
  echo "$base" | sed 's/[^A-Za-z0-9_.-]/-/g'
}

# ---------------------------------------------------------------------------
# slipstream_resolve_target — echoes 'dev' or 'prod'.
#   - Linked worktree: always 'dev' (deploy.sh's hard guard prevents anything
#     from overriding this).
#   - Main worktree: honors $SLIPSTREAM_TARGET if it is exactly 'dev' or
#     'prod', otherwise defaults to 'prod'.
# ---------------------------------------------------------------------------
slipstream_resolve_target() {
  if slipstream_is_linked_worktree; then
    echo "dev"
    return 0
  fi

  case "${SLIPSTREAM_TARGET:-}" in
    dev|prod)
      echo "$SLIPSTREAM_TARGET"
      ;;
    *)
      echo "prod"
      ;;
  esac
}
