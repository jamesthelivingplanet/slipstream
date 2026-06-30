import * as fs from 'node:fs'
import * as path from 'node:path'

export interface GitMcpConfigParams {
  gitMcpJsPath: string
  electronPath: string
  dataDir: string
  sessionId: string
  base: string
  branch: string
}

export function buildGitMcpConfig(params: GitMcpConfigParams): object {
  return {
    mcpServers: {
      'slipstream-git': {
        command: params.electronPath,
        args: [params.gitMcpJsPath],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          SLIPSTREAM_DATA_DIR: params.dataDir,
          SLIPSTREAM_SESSION_ID: params.sessionId,
          SLIPSTREAM_BASE: params.base,
          SLIPSTREAM_BRANCH: params.branch,
        },
      },
    },
  }
}

export async function writeGitMcpConfig(filePath: string, config: object): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
  await fs.promises.writeFile(filePath, JSON.stringify(config, null, 2))
}
