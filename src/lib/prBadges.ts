/** Pure mapping from a fetched PrStatusDTO (FLO-96) to the small set of
 *  header badges TerminalView renders next to the "View PR" link — no
 *  DOM/ipc imports, kept pure so the state → badge-list mapping is
 *  unit-testable on its own (mirrors the ImageUploadDeps convention of
 *  keeping the pure decision logic separate from its caller). */
import type { PrStatusDTO } from '../../electron/shared/contract.js'

export interface PrBadge {
  text: string
  cls: 'done' | 'error' | 'needs' | 'muted'
}

export function prBadges(dto: PrStatusDTO | null): PrBadge[] {
  if (!dto) return []
  if (dto.error) return [{ text: 'PR ?', cls: 'muted' }]
  const badges: PrBadge[] = []
  if (dto.state === 'merged') badges.push({ text: 'merged', cls: 'done' })
  else if (dto.state === 'open') badges.push({ text: 'open', cls: 'muted' })
  else if (dto.state === 'closed') badges.push({ text: 'closed', cls: 'error' })
  if (dto.ci === 'passed') badges.push({ text: 'CI ✓', cls: 'done' })
  else if (dto.ci === 'failed') badges.push({ text: 'CI ✗', cls: 'error' })
  else if (dto.ci === 'pending' || dto.ci === 'running') badges.push({ text: 'CI …', cls: 'needs' })
  if (dto.review === 'approved') badges.push({ text: 'approved', cls: 'done' })
  else if (dto.review === 'changes_requested') badges.push({ text: 'changes', cls: 'error' })
  return badges
}
