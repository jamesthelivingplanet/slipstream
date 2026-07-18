#!/usr/bin/env bash
# Regenerates the FCM status-bar notification icon (mobile/android/app/src/main/res/drawable-*/ic_stat_notify.png)
# from a source SVG — defaults to the brand SVG at public/icons/icon.svg, or pass a different
# SVG as the first arg (e.g. mobile/assets/nulliel-silhouette.svg, TASK-F0TYG) to swap the glyph
# without touching the pipeline below.
#
# Android's notification-icon renderer ignores color and only respects the alpha channel,
# auto-tinting whatever it finds — so the source must be a pure white-on-transparent (or, since
# only alpha matters, any-opaque-color-on-transparent) silhouette, or non-transparent pixels of
# varying alpha get tinted into a blob that doesn't match the intended shape.
#
# Pipeline per density: render the SVG at 8x the target size (crisp AA edges), extract the
# alpha channel, force every pixel's color to solid white, downscale with a Lanczos filter,
# then clamp near-invisible alpha noise (<3%) introduced by the downscale to fully transparent.
#
# Requires: rsvg-convert, ImageMagick (magick). Run from the repo root.
#
# Usage: bash mobile/assets/generate-notification-icon.sh [source.svg]

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SVG="${1:-$REPO_ROOT/public/icons/icon.svg}"
RES_DIR="$REPO_ROOT/mobile/android/app/src/main/res"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

declare -A SIZES=( [mdpi]=24 [hdpi]=36 [xhdpi]=48 [xxhdpi]=72 [xxxhdpi]=96 )

for density in "${!SIZES[@]}"; do
  size="${SIZES[$density]}"
  supersize=$((size * 8))
  out_dir="$RES_DIR/drawable-$density"
  mkdir -p "$out_dir"

  rsvg-convert -w "$supersize" -h "$supersize" "$SVG" -o "$WORK_DIR/raw-$density.png"
  magick "$WORK_DIR/raw-$density.png" -alpha extract "$WORK_DIR/alpha-$density.png"
  magick -size "${supersize}x${supersize}" xc:white -alpha off "$WORK_DIR/white-$density.png"
  magick "$WORK_DIR/white-$density.png" "$WORK_DIR/alpha-$density.png" \
    -alpha off -compose CopyOpacity -composite "$WORK_DIR/super-$density.png"
  magick "$WORK_DIR/super-$density.png" -filter Lanczos -resize "${size}x${size}" \
    "$WORK_DIR/ic_stat_notify-$density.png"
  magick "$WORK_DIR/ic_stat_notify-$density.png" -channel A -level 3%,100% +channel \
    "$WORK_DIR/ic_stat_notify-$density.png"
  magick "$WORK_DIR/ic_stat_notify-$density.png" -fill white -colorize 100 \
    "$out_dir/ic_stat_notify.png"

  echo "wrote $out_dir/ic_stat_notify.png (${size}x${size})"
done
