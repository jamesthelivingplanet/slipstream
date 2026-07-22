/** Slug a ticket title to a branch-safe fragment: first 4 hyphen-separated words. */
export const slug = (title: string): string =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .filter(Boolean)
    .slice(0, 4)
    .join('-')

// No `/`, `\`, or leading `.` — these values flow unmodified into
// `join(root, '.worktrees', ..., value)` (worktreeManager.pathFor) and into
// shell cwds (runApp, openInEditor), so a `..` segment or absolute path must
// never survive validation (FLO-129).
const SAFE_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** True for filesystem-safe path segments — used to validate `tid`/`branch`
 *  values before they reach worktree paths or shell cwds. */
export const isSafeSlug = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 255 &&
  !value.includes('..') &&
  SAFE_SLUG_RE.test(value)

/** Canonical branch name for a ticket+title, e.g. "FLO-5-figure-out-how-to". */
export const branchFor = (tid: string, title: string): string => {
  if (!isSafeSlug(tid)) throw new Error(`Invalid ticket id: ${tid}`)
  return `${tid}-${slug(title)}`
}
