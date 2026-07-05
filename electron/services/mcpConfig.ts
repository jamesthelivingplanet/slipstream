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

/** Env vars injected into the spawned app-MCP process (keys differ by host format). */
export interface McpProcessEnv {
  ELECTRON_RUN_AS_NODE: string
  SLIPSTREAM_DATA_DIR: string
  SLIPSTREAM_SESSION_ID: string
  SLIPSTREAM_BASE: string
  SLIPSTREAM_BRANCH: string
}

/** Claude Code / generic `mcpServers` config (command + args + env). */
export interface AppMcpConfig {
  mcpServers: {
    slipstream: {
      command: string
      args: string[]
      env: McpProcessEnv
    }
  }
}

/** opencode config (`mcp.<name>` with a command array + environment). */
export interface OpencodeMcpConfig {
  mcp: {
    slipstream: {
      type: 'local'
      command: string[]
      environment: McpProcessEnv
      enabled: boolean
    }
  }
}

export function buildAppMcpConfig(params: AppMcpConfigParams): AppMcpConfig {
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

export function buildOpencodeMcpConfig(params: AppMcpConfigParams): OpencodeMcpConfig {
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

export async function writeAppMcpConfig(filePath: string, config: AppMcpConfig): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
  await fs.promises.writeFile(filePath, JSON.stringify(config, null, 2))
}
