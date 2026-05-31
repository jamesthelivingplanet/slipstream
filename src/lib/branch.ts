export const slug = (title: string): string =>
  title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').split('-').slice(0, 4).join('-')

export const branchFor = (tid: string, title: string): string => `${tid}-${slug(title)}`
