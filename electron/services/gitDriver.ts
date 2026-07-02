import { execFile as _execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { GitHost } from '../shared/contract.js'

const execFile = promisify(_execFile)

export function parseRemote(
  remoteUrl: string,
): { host: GitHost; org: string; name: string } | null {
  // SSH pattern: git@gitlab.com:org/name.git, git@github.com:org/name.git
  const sshMatch = remoteUrl.match(/^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/)
  if (sshMatch) {
    const domain = sshMatch[1]
    const org = sshMatch[2]
    const name = sshMatch[3]
    if (domain === 'gitlab.com') return { host: 'gitlab', org, name }
    if (domain === 'github.com') return { host: 'github', org, name }
    return null
  }

  // HTTPS pattern: https://gitlab.com/org/name.git, https://github.com/org/name
  const httpsMatch = remoteUrl.match(/^https:\/\/([^/]+)\/([^/]+)\/(.+?)(?:\.git)?$/)
  if (httpsMatch) {
    const domain = httpsMatch[1]
    const org = httpsMatch[2]
    const name = httpsMatch[3]
    if (domain === 'gitlab.com') return { host: 'gitlab', org, name }
    if (domain === 'github.com') return { host: 'github', org, name }
    return null
  }

  return null
}

export function gitlabProjectPath(org: string, name: string): string {
  return encodeURIComponent(`${org}/${name}`)
}

export function configKeyForHost(host: GitHost): string {
  return `${host}.token`
}

export function redact(s: string, token: string): string {
  if (!token) return s
  return s.split(token).join('***')
}

export function buildGitlabCreateMrDescriptor(params: {
  org: string
  name: string
  branch: string
  base: string
  title: string
  description: string
  token: string
}): { url: string; method: string; headers: Record<string, string>; body: string } {
  const projectPath = gitlabProjectPath(params.org, params.name)
  return {
    url: `https://gitlab.com/api/v4/projects/${projectPath}/merge_requests`,
    method: 'POST',
    headers: {
      'PRIVATE-TOKEN': params.token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      source_branch: params.branch,
      target_branch: params.base,
      title: params.title,
      description: params.description,
    }),
  }
}

export function buildGitlabFindMrDescriptor(params: {
  org: string
  name: string
  branch: string
  token: string
}): { url: string; method: string; headers: Record<string, string> } {
  const projectPath = gitlabProjectPath(params.org, params.name)
  return {
    url: `https://gitlab.com/api/v4/projects/${projectPath}/merge_requests?state=opened&source_branch=${encodeURIComponent(params.branch)}`,
    method: 'GET',
    headers: {
      'PRIVATE-TOKEN': params.token,
    },
  }
}

export function buildGithubCreatePrDescriptor(params: {
  org: string
  name: string
  branch: string
  base: string
  title: string
  body: string
  token: string
}): { url: string; method: string; headers: Record<string, string>; body: string } {
  return {
    url: `https://api.github.com/repos/${params.org}/${params.name}/pulls`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: params.title,
      head: params.branch,
      base: params.base,
      body: params.body,
    }),
  }
}

export function buildGithubFindPrDescriptor(params: {
  org: string
  name: string
  org_login: string
  branch: string
  token: string
}): { url: string; method: string; headers: Record<string, string> } {
  return {
    url: `https://api.github.com/repos/${params.org}/${params.name}/pulls?state=open&head=${encodeURIComponent(params.org_login)}:${encodeURIComponent(params.branch)}`,
    method: 'GET',
    headers: {
      Authorization: `Bearer ${params.token}`,
      Accept: 'application/vnd.github+json',
    },
  }
}

export interface GitDriver {
  push(cwd: string, branch: string, opts?: { token?: string; remoteUrl?: string }): Promise<void>
  openMergeRequest(input: {
    remoteUrl: string
    branch: string
    base: string
    title: string
    body: string
    token: string
  }): Promise<{ url: string; isNew: boolean }>
}

export function createGitDriver(): GitDriver {
  return {
    async push(cwd, branch, opts) {
      const token = opts?.token
      const remoteUrl = opts?.remoteUrl

      if (remoteUrl && token && remoteUrl.startsWith('https://')) {
        // Build authenticated URL
        const parsed = parseRemote(remoteUrl)
        if (parsed) {
          const { org, name } = parsed
          // Extract domain from remoteUrl
          const domainMatch = remoteUrl.match(/^https:\/\/([^/]+)/)
          const domain = domainMatch ? domainMatch[1] : 'github.com'
          const authUrl = `https://oauth2:${token}@${domain}/${org}/${name}.git`
          try {
            await execFile('git', ['-C', cwd, 'push', authUrl, `HEAD:refs/heads/${branch}`])
          } catch (err: unknown) {
            const e = err as { stderr?: string; message?: string }
            const msg = e.stderr ?? e.message ?? String(err)
            throw new Error(redact(msg, token), { cause: err })
          }
          return
        }
      }

      // SSH or fallback
      try {
        await execFile('git', ['-C', cwd, 'push', '-u', 'origin', branch])
      } catch (err: unknown) {
        const e = err as { stderr?: string; message?: string }
        const msg = e.stderr ?? e.message ?? String(err)
        throw new Error(token ? redact(msg, token) : msg, { cause: err })
      }
    },

    async openMergeRequest(input) {
      const { remoteUrl, branch, base, title, body, token } = input
      const parsed = parseRemote(remoteUrl)
      if (!parsed) throw new Error(`Cannot parse remote URL: ${remoteUrl}`)

      const { host, org, name } = parsed

      if (host === 'gitlab') {
        // Find existing MR
        const findDesc = buildGitlabFindMrDescriptor({ org, name, branch, token })
        const findRes = await fetch(findDesc.url, {
          method: findDesc.method,
          headers: findDesc.headers,
        })
        if (findRes.ok) {
          const mrs = (await findRes.json()) as Array<{ web_url: string }>
          if (mrs.length > 0) {
            return { url: mrs[0].web_url, isNew: false }
          }
        }

        // Create MR
        const createDesc = buildGitlabCreateMrDescriptor({
          org,
          name,
          branch,
          base,
          title,
          description: body,
          token,
        })
        const createRes = await fetch(createDesc.url, {
          method: createDesc.method,
          headers: createDesc.headers,
          body: createDesc.body,
        })
        if (!createRes.ok) {
          const errBody = await createRes.text()
          throw new Error(`GitLab MR creation failed (${createRes.status}): ${errBody}`)
        }
        const mr = (await createRes.json()) as { web_url: string }
        return { url: mr.web_url, isNew: true }
      } else {
        // GitHub
        const findDesc = buildGithubFindPrDescriptor({ org, name, org_login: org, branch, token })
        const findRes = await fetch(findDesc.url, {
          method: findDesc.method,
          headers: findDesc.headers,
        })
        if (findRes.ok) {
          const prs = (await findRes.json()) as Array<{ html_url: string }>
          if (prs.length > 0) {
            return { url: prs[0].html_url, isNew: false }
          }
        }

        // Create PR
        const createDesc = buildGithubCreatePrDescriptor({
          org,
          name,
          branch,
          base,
          title,
          body,
          token,
        })
        const createRes = await fetch(createDesc.url, {
          method: createDesc.method,
          headers: createDesc.headers,
          body: createDesc.body,
        })
        if (!createRes.ok) {
          const errBody = await createRes.text()
          throw new Error(`GitHub PR creation failed (${createRes.status}): ${errBody}`)
        }
        const pr = (await createRes.json()) as { html_url: string }
        return { url: pr.html_url, isNew: true }
      }
    },
  }
}
