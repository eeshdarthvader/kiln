import { basename } from 'node:path';
import type { StageName } from '../domain.ts';

/** Single-quotes a value for bash. */
export const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

export interface StageLaunch {
  runId: string;
  stage: StageName;
  attempt: number;
  worktreePath: string;
  repositoryPath: string;
  runDirectory: string;
  promptFile: string;
  mcpUrl: string;
  image: string;
  envFile: string;
  /** Extra `docker run` arguments, e.g. `--add-host=host.docker.internal:host-gateway` on Linux. */
  dockerArgs?: string;
  model?: string;
  /** Test hook: a host command to run instead of the agent container. */
  agentCommand?: string;
}

/**
 * The script a Herdr pane runs for one stage. It ends in `exec`, so the pane exits when the
 * agent does. The worktree and its parent repository are mounted at their host paths because
 * a git worktree refers to its repository by absolute path.
 */
export function launchScript(launch: StageLaunch): string {
  const environment: Record<string, string> = {
    FACTORY_RUN_ID: launch.runId,
    FACTORY_STAGE: launch.stage,
    FACTORY_ATTEMPT: String(launch.attempt),
    FACTORY_MCP_URL: launch.mcpUrl,
    FACTORY_PROMPT_FILE: launch.promptFile,
    FACTORY_RUN_DIR: launch.runDirectory,
    FACTORY_WORKTREE: launch.worktreePath,
    ...(launch.model ? { FACTORY_AGENT_MODEL: launch.model } : {}),
  };
  const lines = ['#!/usr/bin/env bash', 'set -euo pipefail'];
  if (launch.agentCommand) {
    for (const [name, value] of Object.entries(environment))
      lines.push(`export ${name}=${quote(value)}`);
    lines.push(`cd ${quote(launch.worktreePath)}`, `exec ${launch.agentCommand}`);
    return `${lines.join('\n')}\n`;
  }
  const name = `factory-${launch.runId.slice(0, 8)}-${launch.stage}-${launch.attempt}`;
  const args = [
    'exec docker run --rm -it',
    `--name ${quote(name)}`,
    ...(launch.dockerArgs ? [launch.dockerArgs] : []),
    `--env-file ${quote(launch.envFile)}`,
    ...Object.entries(environment).map(([key, value]) => `-e ${quote(`${key}=${value}`)}`),
    `-v ${quote(`${launch.repositoryPath}:${launch.repositoryPath}`)}`,
    `-v ${quote(`${launch.worktreePath}:${launch.worktreePath}`)}`,
    `-v ${quote(`${launch.runDirectory}:${launch.runDirectory}`)}`,
    `-w ${quote(launch.worktreePath)}`,
    quote(launch.image),
  ];
  lines.push(`# ${basename(launch.promptFile)}`, args.join(' \\\n  '));
  return `${lines.join('\n')}\n`;
}
