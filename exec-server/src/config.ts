import { isAbsolute } from 'node:path';

export interface Config {
  port: number;
  mcpPort: number;
  opencodeUrl: string;
  opencodePublicUrl?: string;
  opencodePassword: string;
  workspaceRoot: string;
  startDocker: boolean;
  apiToken?: string;
}

function endpoint(value: string, name = 'OPENCODE_URL'): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an HTTP(S) URL without credentials, query or fragment.`);
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(`${name} must be an HTTP(S) URL without credentials, query or fragment.`);
  return value.replace(/\/$/, '');
}

function port(value: string | undefined, fallback: number, name: string): number {
  if (value !== undefined && !/^\d+$/.test(value))
    throw new Error(`${name} must be an integer from 1 to 65535.`);
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535)
    throw new Error(`${name} must be an integer from 1 to 65535.`);
  return parsed;
}

export function configuration(env: NodeJS.ProcessEnv = process.env): Config {
  const apiPort = port(env.SAWD_PORT, 3775, 'SAWD_PORT');
  const mcpPort = port(env.SAWD_MCP_PORT, 3776, 'SAWD_MCP_PORT');
  if (apiPort === mcpPort) throw new Error('SAWD_PORT and SAWD_MCP_PORT must differ.');
  if (env.SAWD_START_DOCKER !== undefined && !['true', 'false'].includes(env.SAWD_START_DOCKER))
    throw new Error('SAWD_START_DOCKER must be true or false.');
  const apiToken = env.SAWD_API_TOKEN;
  if (apiToken !== undefined && (!apiToken || /\s/.test(apiToken) || apiToken.length > 8192))
    throw new Error('SAWD_API_TOKEN must be a nonempty token without whitespace.');
  const workspaceRoot = env.SAWD_WORKSPACE_ROOT ?? '/workspace/sawd';
  if (!isAbsolute(workspaceRoot) || /[\x00-\x1f]/.test(workspaceRoot))
    throw new Error('SAWD_WORKSPACE_ROOT must be an absolute directory path.');
  const opencodePassword = env.OPENCODE_PASSWORD ?? env.OPENCODE_SERVER_PASSWORD;
  if (!opencodePassword || /[\x00-\x1f\x7f]/.test(opencodePassword))
    throw new Error(
      'OPENCODE_PASSWORD (or legacy OPENCODE_SERVER_PASSWORD) must be nonempty and contain no control characters.',
    );
  if (env.OPENCODE_SERVER_USERNAME !== undefined && env.OPENCODE_SERVER_USERNAME !== 'opencode')
    throw new Error(
      'OpenCode v2 requires username opencode; remove OPENCODE_SERVER_USERNAME or set it to opencode.',
    );
  return {
    port: apiPort,
    mcpPort,
    opencodeUrl: endpoint(env.OPENCODE_URL ?? 'http://127.0.0.1:3773'),
    ...(env.OPENCODE_PUBLIC_URL === undefined
      ? {}
      : { opencodePublicUrl: endpoint(env.OPENCODE_PUBLIC_URL, 'OPENCODE_PUBLIC_URL') }),
    opencodePassword,
    workspaceRoot,
    startDocker: env.SAWD_START_DOCKER === 'true',
    ...(apiToken === undefined ? {} : { apiToken }),
  };
}
