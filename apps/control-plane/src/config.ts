import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { autonomyLevels, type Autonomy } from './domain.ts';

export interface Config {
  port: number;
  mcpPort: number;
  /** Address the reporting MCP listener binds to. Containers reach it through `mcpPublicUrl`. */
  mcpHost: string;
  mcpPublicUrl: string;
  apiToken?: string;
  /** Holds run records, repository clones, worktrees and per-run agent files. */
  home: string;
  repos: string[];
  label: string;
  /** Autonomy for repositories without a `.factory/policy.json`. */
  autonomy: Autonomy;
  pollSeconds: number;
  maxRuns: number;
  maxStageAttempts: number;
  stageTimeoutMinutes: number;
  herdrSession: string;
  herdrSocket: string;
  agentImage: string;
  /** Extra `docker run` arguments for agent containers. */
  agentDockerArgs?: string;
  /** Test hook: run this host command in the pane instead of the agent container. */
  agentCommand?: string;
  agentModel?: string;
  /** Serve a host shell over a WebSocket for the dashboard's terminal. */
  terminal: boolean;
  terminalShell: string;
}

function integer(
  value: string | undefined,
  fallback: number,
  name: string,
  min: number,
  max: number,
) {
  if (value !== undefined && !/^\d+$/.test(value))
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max)
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  return parsed;
}

function httpUrl(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an HTTP(S) URL.`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error(`${name} must be an HTTP(S) URL without credentials.`);
  return value.replace(/\/$/, '');
}

export function configuration(env: NodeJS.ProcessEnv = process.env): Config {
  const port = integer(env.FACTORY_PORT, 3775, 'FACTORY_PORT', 1, 65535);
  const mcpPort = integer(env.FACTORY_MCP_PORT, 3776, 'FACTORY_MCP_PORT', 1, 65535);
  if (port === mcpPort) throw new Error('FACTORY_PORT and FACTORY_MCP_PORT must differ.');
  const apiToken = env.FACTORY_API_TOKEN;
  if (apiToken !== undefined && (!apiToken || /\s/.test(apiToken) || apiToken.length > 8192))
    throw new Error('FACTORY_API_TOKEN must be a nonempty token without whitespace.');
  const home = env.FACTORY_HOME ?? join(homedir(), '.factory');
  if (!isAbsolute(home) || /[\x00-\x1f]/.test(home))
    throw new Error('FACTORY_HOME must be an absolute directory path.');
  const repos = (env.FACTORY_REPOS ?? '')
    .split(',')
    .map((repo) => repo.trim())
    .filter(Boolean);
  for (const repo of repos)
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo))
      throw new Error(`FACTORY_REPOS entry "${repo}" must use the owner/name form.`);
  const label = env.FACTORY_LABEL ?? 'factory';
  if (!/^[\w.-]{1,40}$/.test(label))
    throw new Error('FACTORY_LABEL must be 1-40 letters, digits, dots, dashes or underscores.');
  const autonomy = env.FACTORY_AUTONOMY ?? 'L1';
  if (!(autonomyLevels as readonly string[]).includes(autonomy))
    throw new Error('FACTORY_AUTONOMY must be L0, L1, L2 or L3.');
  const herdrSession = env.HERDR_SESSION ?? 'factory';
  if (!/^[\w-]{1,64}$/.test(herdrSession))
    throw new Error('HERDR_SESSION must be 1-64 letters, digits, dashes or underscores.');
  const herdrSocket =
    env.HERDR_SOCKET_PATH ??
    join(homedir(), '.config', 'herdr', 'sessions', herdrSession, 'herdr.sock');
  return {
    port,
    mcpPort,
    mcpHost: env.FACTORY_MCP_HOST ?? '127.0.0.1',
    mcpPublicUrl: httpUrl(
      env.FACTORY_MCP_PUBLIC_URL ?? `http://host.docker.internal:${mcpPort}`,
      'FACTORY_MCP_PUBLIC_URL',
    ),
    ...(apiToken === undefined ? {} : { apiToken }),
    home,
    repos,
    label,
    autonomy: autonomy as Autonomy,
    pollSeconds: integer(env.FACTORY_POLL_SECONDS, 60, 'FACTORY_POLL_SECONDS', 0, 86_400),
    maxRuns: integer(env.FACTORY_MAX_RUNS, 2, 'FACTORY_MAX_RUNS', 1, 16),
    maxStageAttempts: integer(
      env.FACTORY_MAX_STAGE_ATTEMPTS,
      3,
      'FACTORY_MAX_STAGE_ATTEMPTS',
      1,
      10,
    ),
    stageTimeoutMinutes: integer(
      env.FACTORY_STAGE_TIMEOUT_MINUTES,
      45,
      'FACTORY_STAGE_TIMEOUT_MINUTES',
      1,
      1440,
    ),
    herdrSession,
    herdrSocket,
    agentImage: env.FACTORY_AGENT_IMAGE ?? 'localhost/factory-agent:latest',
    ...(env.FACTORY_AGENT_DOCKER_ARGS ? { agentDockerArgs: env.FACTORY_AGENT_DOCKER_ARGS } : {}),
    ...(env.FACTORY_AGENT_COMMAND ? { agentCommand: env.FACTORY_AGENT_COMMAND } : {}),
    terminal: !['off', 'false', '0'].includes((env.FACTORY_TERMINAL ?? 'on').toLowerCase()),
    terminalShell: env.FACTORY_TERMINAL_SHELL ?? env.SHELL ?? '/bin/sh',
    ...(env.FACTORY_AGENT_MODEL ? { agentModel: env.FACTORY_AGENT_MODEL } : {}),
  };
}
