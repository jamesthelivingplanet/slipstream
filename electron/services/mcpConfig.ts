import * as fs from 'node:fs'
import * as path from 'node:path'

export interface AppMcpConfigParams {
  appMcpJsPath: string
  electronPath: string
  dataDir: string
  sessionId: string
  base: string
  branch: string
}

export function buildAppMcpConfig(params: AppMcpConfigParams): object {
  return {
    mcpServers: {
      slipstream: {
        command: params.electronPath,
        args: [params.appMcpJsPath],
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

export function buildOpencodeMcpConfig(params: AppMcpConfigParams): object {
  return {
    mcp: {
      slipstream: {
        type: 'local',
        command: [params.electronPath, params.appMcpJsPath],
        environment: {
          ELECTRON_RUN_AS_NODE: '1',
          SLIPSTREAM_DATA_DIR: params.dataDir,
          SLIPSTREAM_SESSION_ID: params.sessionId,
          SLIPSTREAM_BASE: params.base,
          SLIPSTREAM_BRANCH: params.branch,
        },
        enabled: true,
      },
    },
  }
}

export async function writeAppMcpConfig(filePath: string, config: object): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
  await fs.promises.writeFile(filePath, JSON.stringify(config, null, 2))
}
