#!/usr/bin/env node
/**
 * Regenerate every PWA/desktop PNG icon from the single source of truth:
 * public/icons/icon.svg (the web favicon + in-app header logo).
 *
 * Run this after editing icon.svg so the favicon, PWA manifest icons, Apple
 * touch icon, and electron-builder desktop icon all stay in sync — i.e. "all
 * application icons are the same one." Requires ImageMagick (`magick`) on
 * PATH; this is a manual tooling script, not wired into the build (CI's node
 * image does not ship ImageMagick).
 *
 * icon.svg embeds the logo as a base64 PNG. We extract that PNG rather than
 * rendering the SVG through rsvg, which flattens the logo's transparency onto
 * a white background.
 */
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const icons = resolve(root, 'public/icons')
// Matches manifest.webmanifest background_color / theme_color.
const bg = '#0a0a0b'

const svg = readFileSync(resolve(icons, 'icon.svg'), 'utf8')
const match = svg.match(/data:image\/png;base64,([A-Za-z0-9+/=]+)/)
if (!match?.[1]) throw new Error('No embedded PNG found in public/icons/icon.svg')

const pid = process.pid
const src = resolve(tmpdir(), `slipstream-icon-src-${pid}.png`)
const swirlLg = resolve(tmpdir(), `slipstream-swirl-384-${pid}.png`)
const swirlSm = resolve(tmpdir(), `slipstream-swirl-144-${pid}.png`)
writeFileSync(src, match[1], 'base64')

const out = (name) => resolve(icons, name)
const run = (cmd) => execSync(cmd, { stdio: 'inherit' })

try {
  // "any" purpose icons — transparent background, identical to the web favicon.
  run(`magick "${src}" -resize 512x512 "${out('icon-512.png')}"`)
  run(`magick "${src}" -resize 192x192 "${out('icon-192.png')}"`)

  // Maskable icons — full-bleed background, logo padded into the safe zone.
  run(`magick "${src}" -resize 384x384 "${swirlLg}"`)
  run(
    `magick -size 512x512 "xc:${bg}" "${swirlLg}" -gravity center -composite "${out('maskable-512.png')}"`,
  )
  run(`magick "${src}" -resize 144x144 "${swirlSm}"`)
  run(
    `magick -size 192x192 "xc:${bg}" "${swirlSm}" -gravity center -composite "${out('maskable-192.png')}"`,
  )

  // Apple touch icon — solid background (iOS ignores alpha), logo centered.
  run(
    `magick -size 180x180 "xc:${bg}" "${swirlSm}" -gravity center -composite "${out('apple-touch-icon.png')}"`,
  )
} finally {
  for (const p of [src, swirlLg, swirlSm]) if (existsSync(p)) unlinkSync(p)
}

console.log('Regenerated PWA/desktop icons from public/icons/icon.svg')
