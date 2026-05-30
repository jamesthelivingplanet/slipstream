import type { Repo, Session, Ticket } from './types'

export const repos: Repo[] = [
  { id: 'api', org: 'acme', name: 'api', base: 'main' },
  { id: 'web', org: 'acme', name: 'web', base: 'main' },
  { id: 'mobile', org: 'acme', name: 'mobile', base: 'develop' },
  { id: 'billing', org: 'internal', name: 'billing', base: 'master' },
]

export const initialSessions: Session[] = [
  {
    repo: null, suggestedRepo: 'api', tid: 'PROJ-152', src: 'jira', status: 'idle',
    title: 'Add rate limiting to /export endpoint', branch: null, add: 0, del: 0, ago: 'draft',
    prompt: 'PROJ-152: Add rate limiting to /export endpoint.\n\nInvestigate and implement a fix. Add tests, then open a PR.',
    activity: { text: 'Not started — choose a repo and start.' },
  },
  {
    repo: 'api', tid: 'PROJ-128', src: 'jira', status: 'needs',
    title: 'Fix auth redirect loop on token refresh', branch: 'PROJ-128-fix-auth-redirect',
    add: 42, del: 8, ago: '2m',
    activity: { text: 'Asked whether to invalidate or migrate sessions.' },
  },
  {
    repo: 'api', tid: 'PROJ-131', src: 'linear', status: 'running',
    title: 'Refactor cache layer to LRU', branch: 'PROJ-131-refactor-cache',
    add: 210, del: 64, ago: 'just now',
    activity: { text: 'Running test suite — 84/120 passing…' },
  },
  {
    repo: 'mobile', tid: 'PROJ-145', src: 'linear', status: 'running',
    title: 'Onboarding skeleton screens', branch: 'PROJ-145-onboarding-skeleton',
    add: 130, del: 4, ago: 'just now',
    activity: { text: 'Scaffolding components in src/onboarding/…' },
  },
  {
    repo: 'web', tid: 'PROJ-140', src: 'jira', status: 'done',
    title: 'Upgrade to router v7', branch: 'PROJ-140-upgrade-router',
    add: 96, del: 120, ago: '6m',
    activity: { text: 'Done. 14 files changed, ready to review.' },
  },
]

export const initialTickets: Ticket[] = [
  { tid: 'PROJ-149', src: 'linear', title: 'Dark mode flickers on cold load', repo: 'web' },
  { tid: 'BILL-22', src: 'linear', title: 'Stripe webhook retries dropping events', repo: 'billing' },
  { tid: 'PROJ-160', src: 'jira', title: 'Migrate package manager to pnpm', repo: 'web' },
  { tid: 'PROJ-158', src: 'jira', title: 'Push notification permission UX', repo: 'mobile' },
]

export const repoOf = (id: string | null | undefined): Repo | undefined =>
  repos.find((r) => r.id === id)

export const slug = (title: string): string =>
  title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').split('-').slice(0, 4).join('-')

export const branchFor = (tid: string, title: string): string => `${tid}-${slug(title)}`
