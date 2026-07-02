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

/** Canonical branch name for a ticket+title, e.g. "FLO-5-figure-out-how-to". */
export const branchFor = (tid: string, title: string): string => `${tid}-${slug(title)}`
