#!/usr/bin/env bash
# release.sh — bump the app version, roll CHANGELOG.md's [Unreleased] section
# into a dated entry, commit, tag, and push. Implements the release flow
# documented in docs/VERSIONING.md.
#
# Usage:
#   pnpm release          # minor bump (default)
#   pnpm release patch
#   pnpm release minor
#   pnpm release major
#   SKIP_CHECKS=1 pnpm release   # skip pnpm check / pnpm test / pnpm lint
#
# (If your pnpm version needs it: `pnpm release -- patch` also works.)
#
# This only versions and tags a commit on master — it does not deploy
# anything. Run 'pnpm deploy' separately to update a running service; CI's
# publish-image job (.gitlab-ci.yml) publishes the pod image on every merge
# to master regardless of tags.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$REPO_ROOT"

# ---------------------------------------------------------------------------
# Parse args
# ---------------------------------------------------------------------------
BUMP="${1:-minor}"
case "$BUMP" in
  patch | minor | major) ;;
  *)
    echo "✗ Unknown release type '$BUMP' — expected patch, minor, or major."
    exit 1
    ;;
esac

SKIP_CHECKS="${SKIP_CHECKS:-0}"

# ---------------------------------------------------------------------------
# Phase 1: Safety checks
# ---------------------------------------------------------------------------
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$BRANCH" != "master" ]]; then
  echo "✗ Releases are cut from 'master', but you're on '$BRANCH'."
  echo "  Merge this branch first, switch to master, and re-run 'pnpm release'."
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "✗ Working tree is not clean — commit or stash your changes first."
  git status --short
  exit 1
fi

echo "▶ Fetching origin/master…"
git fetch origin master --quiet

BEHIND="$(git rev-list --count HEAD..origin/master)"
if [[ "$BEHIND" -gt 0 ]]; then
  echo "✗ Local master is behind origin/master by ${BEHIND} commit(s)."
  echo "  Run 'git pull --rebase origin master' first."
  exit 1
fi

# ---------------------------------------------------------------------------
# Phase 2: Quality gates
# ---------------------------------------------------------------------------
if [[ "$SKIP_CHECKS" == "1" ]]; then
  echo "⚠  Skipping quality gates (SKIP_CHECKS=1)."
else
  echo "▶ Running type-check (pnpm check)…"
  pnpm check

  echo "▶ Running tests (pnpm test)…"
  pnpm test

  echo "▶ Running lint (pnpm lint)…"
  pnpm lint
fi

# ---------------------------------------------------------------------------
# Phase 3: Bump version
# ---------------------------------------------------------------------------
echo "▶ Bumping ${BUMP} version…"
NEW_VERSION="$(npm version "$BUMP" --no-git-tag-version | sed 's/^v//')"
echo "  New version: ${NEW_VERSION}"

# ---------------------------------------------------------------------------
# Phase 4: Roll CHANGELOG.md's [Unreleased] section into a dated entry
# ---------------------------------------------------------------------------
echo "▶ Updating CHANGELOG.md…"
if ! node scripts/bumpChangelog.mjs "$NEW_VERSION"; then
  # `npm version` bumps both package.json AND package-lock.json's embedded
  # version field (standard npm behavior, even in this pnpm project) — revert
  # both or the working tree is left half-reverted and dirty.
  echo "  Reverting version bump…"
  git checkout -- package.json package-lock.json
  exit 1
fi

# ---------------------------------------------------------------------------
# Phase 5: Commit, tag, push
# ---------------------------------------------------------------------------
echo "▶ Committing…"
git add package.json CHANGELOG.md
git commit -m "Release v${NEW_VERSION}"

echo "▶ Tagging v${NEW_VERSION}…"
git tag -a "v${NEW_VERSION}" -m "Release v${NEW_VERSION}"

echo "▶ Pushing master + tag…"
git push origin master
git push origin "v${NEW_VERSION}"

echo ""
echo "✔ Released v${NEW_VERSION}!"
echo "  CI publishes the pod image from this master commit (.gitlab-ci.yml's publish-image job)."
echo "  Run 'pnpm deploy' to update a running service to this version."
