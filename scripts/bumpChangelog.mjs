#!/usr/bin/env node
// Moves CHANGELOG.md's "## [Unreleased]" section content under a new dated
// version heading, leaving an empty "## [Unreleased]" section behind.
// Invoked by scripts/release.sh — see docs/VERSIONING.md.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const changelogPath = fileURLToPath(new URL('../CHANGELOG.md', import.meta.url))
const version = process.argv[2]
if (!version) {
  console.error('Usage: node scripts/bumpChangelog.mjs <version>')
  process.exit(1)
}

const lines = readFileSync(changelogPath, 'utf-8').split('\n')

const unreleasedIdx = lines.findIndex((l) => l.trim() === '## [Unreleased]')
if (unreleasedIdx === -1) {
  console.error('CHANGELOG.md has no "## [Unreleased]" heading to release.')
  process.exit(1)
}

let nextHeadingIdx = lines.findIndex((l, i) => i > unreleasedIdx && l.startsWith('## ['))
if (nextHeadingIdx === -1) nextHeadingIdx = lines.length

const body = lines.slice(unreleasedIdx + 1, nextHeadingIdx)
if (!body.some((l) => l.trim().length > 0)) {
  console.error(
    'Nothing under "## [Unreleased]" to release — add a changelog entry before releasing.',
  )
  process.exit(1)
}

const date = new Date().toISOString().slice(0, 10)
const rebuilt = [
  ...lines.slice(0, unreleasedIdx),
  '## [Unreleased]',
  '',
  `## [${version}] - ${date}`,
  ...body,
  ...lines.slice(nextHeadingIdx),
]

writeFileSync(changelogPath, rebuilt.join('\n'))
console.log(`CHANGELOG.md: [Unreleased] -> [${version}] - ${date}`)
