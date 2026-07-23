#!/usr/bin/env bash
# apk.sh — Android debug APK build/store helpers, shared by release.sh and
# deploy.sh. Sourced, not executed; functions only, no top-level side effects.
#
# Build store: $REPO_ROOT/dist-apk (durable — outside dist/, which vite build
# wipes on every 'pnpm build'). Files are named slipstream-<version>.apk.

# ---------------------------------------------------------------------------
# Resolve REPO_ROOT if the caller hasn't already set it (mirrors node22.sh's
# expectation that callers cd to repo root, but this lib can stand alone too).
# ---------------------------------------------------------------------------
if [[ -z "${REPO_ROOT:-}" ]]; then
  _APK_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  REPO_ROOT="$(dirname "$_APK_LIB_DIR")"
fi

# ---------------------------------------------------------------------------
# Toolchain resolution — JDK 21 + Android SDK, both overridable by env.
# ---------------------------------------------------------------------------
apk_java_home() {
  if [[ -n "${JAVA_HOME:-}" && -x "${JAVA_HOME}/bin/java" ]]; then
    echo "$JAVA_HOME"
  else
    echo "$HOME/.local/share/jdk-21"
  fi
}

apk_sdk_root() {
  if [[ -n "${ANDROID_SDK_ROOT:-}" ]]; then
    echo "$ANDROID_SDK_ROOT"
  elif [[ -n "${ANDROID_HOME:-}" ]]; then
    echo "$ANDROID_HOME"
  else
    echo "$HOME/Android/Sdk"
  fi
}

# ---------------------------------------------------------------------------
# apk_store_dir — durable APK output dir, outside dist/. Creates it if asked
# to build into it; just echoes the path otherwise.
# ---------------------------------------------------------------------------
apk_store_dir() {
  echo "$REPO_ROOT/dist-apk"
}

# ---------------------------------------------------------------------------
# apk_toolchain_ready — 0 if JDK dir, SDK dir, and the gradle wrapper all
# exist; non-zero otherwise. Callers use this to decide warn-and-skip.
# ---------------------------------------------------------------------------
apk_toolchain_ready() {
  local jdk sdk gradlew
  jdk="$(apk_java_home)"
  sdk="$(apk_sdk_root)"
  gradlew="$REPO_ROOT/mobile/android/gradlew"

  [[ -d "$jdk" ]] && [[ -d "$sdk" ]] && [[ -x "$gradlew" || -f "$gradlew" ]]
}

# ---------------------------------------------------------------------------
# apk_build <version> — builds the debug APK and copies it into the store as
# slipstream-<version>.apk. Prints a warning and returns non-zero WITHOUT
# throwing if the toolchain isn't present; returns non-zero on a real gradle
# failure too — the caller decides whether that's fatal.
# ---------------------------------------------------------------------------
apk_build() {
  local version="$1"

  if ! apk_toolchain_ready; then
    echo "⚠  Android toolchain not found — skipping APK build."
    echo "   Expected JDK at $(apk_java_home), SDK at $(apk_sdk_root),"
    echo "   and gradle wrapper at $REPO_ROOT/mobile/android/gradlew."
    return 1
  fi

  local store
  store="$(apk_store_dir)"
  mkdir -p "$store"

  echo "  Syncing mobile dependencies (pnpm install)…"
  if ! pnpm --dir "$REPO_ROOT/mobile" install; then
    echo "✗ pnpm install in mobile/ failed."
    return 1
  fi

  local built="$REPO_ROOT/mobile/android/app/build/outputs/apk/debug/app-debug.apk"

  if ! (
    cd "$REPO_ROOT/mobile/android" && \
    JAVA_HOME="$(apk_java_home)" \
    ANDROID_SDK_ROOT="$(apk_sdk_root)" \
    ANDROID_HOME="$(apk_sdk_root)" \
    ./gradlew assembleDebug
  ); then
    echo "✗ gradle assembleDebug failed."
    return 1
  fi

  if [[ ! -f "$built" ]]; then
    echo "✗ gradle assembleDebug succeeded but ${built} was not found."
    return 1
  fi

  cp "$built" "$store/slipstream-${version}.apk"
  echo "  APK stored at $store/slipstream-${version}.apk"
}

# ---------------------------------------------------------------------------
# apk_latest — prints the path to the newest slipstream-*.apk in the store,
# selected by version order. Prints nothing / returns non-zero if none exist.
# ---------------------------------------------------------------------------
apk_latest() {
  local store latest
  store="$(apk_store_dir)"
  latest="$(ls "$store"/slipstream-*.apk 2>/dev/null | sort -V | tail -1)" || true

  if [[ -z "$latest" ]]; then
    return 1
  fi

  echo "$latest"
}

# ---------------------------------------------------------------------------
# apk_publish_to_dist <dist_dir> — copies the latest APK into <dist_dir>/
# under both its versioned basename and slipstream-latest.apk. Non-zero (no
# error thrown) if there is no APK to publish.
# ---------------------------------------------------------------------------
apk_publish_to_dist() {
  local dist_dir="$1"
  local latest

  latest="$(apk_latest)" || return 1

  mkdir -p "$dist_dir"
  cp "$latest" "$dist_dir/$(basename "$latest")"
  cp "$latest" "$dist_dir/slipstream-latest.apk"
}
