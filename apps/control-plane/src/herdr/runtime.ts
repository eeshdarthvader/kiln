import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Config } from '../config.ts';
import type { Run, StageName } from '../domain.ts';
import type { AgentRuntime } from '../ports.ts';
import { HerdrError, type HerdrClient } from './client.ts';
import { launchScript, quote } from './command.ts';

const run = promisify(execFile);

interface WorkspaceInfo {
  workspace_id: string;
}

export class HerdrRuntime implements AgentRuntime {
  private readonly client: HerdrClient;
  private readonly config: Config;
  private readonly listeners = new Set<(paneId: string) => void>();
  private unsubscribe: (() => void) | undefined;
  constructor(client: HerdrClient, config: Config) {
    this.client = client;
    this.config = config;
  }

  /** Fails fast when the Herdr session is not running. */
  async connect(): Promise<void> {
    await this.client.call('ping');
    this.unsubscribe = this.client.subscribe(
      [{ type: 'pane.exited' }, { type: 'pane.closed' }],
      ({ data }) => {
        const paneId = data.pane_id;
        if (typeof paneId === 'string') for (const listener of this.listeners) listener(paneId);
      },
    );
  }

  runDirectory(runId: string): string {
    return join(this.config.home, 'runs-data', runId);
  }

  async createWorkspace(target: Run, repositoryPath: string) {
    const path = join(this.config.home, 'worktrees', target.id);
    const label = `#${target.issueNumber} ${target.title}`.slice(0, 60);
    let result: { workspace: WorkspaceInfo };
    if (existsSync(path)) {
      result = await this.client.call('worktree.open', {
        cwd: repositoryPath,
        path,
        label,
        focus: false,
        trust_repository: true,
      });
    } else {
      // A branch left behind by an earlier attempt would make git refuse to create the worktree.
      await run('git', ['-C', repositoryPath, 'worktree', 'prune']).catch(() => {});
      await run('git', ['-C', repositoryPath, 'branch', '-D', target.branch]).catch(() => {});
      await mkdir(join(this.config.home, 'worktrees'), { recursive: true });
      result = await this.client.call('worktree.create', {
        cwd: repositoryPath,
        branch: target.branch,
        base: `origin/${target.baseBranch}`,
        path,
        label,
        focus: false,
        trust_repository: true,
      });
    }
    // Herdr also opens a workspace for the source repository. It stays: it is the group that
    // this repository's run workspaces hang under, and Herdr refuses to close it while they exist.
    await mkdir(join(this.runDirectory(target.id), 'stages'), { recursive: true });
    return { worktreePath: path, workspaceId: result.workspace.workspace_id };
  }

  async startStage(target: Run, stage: StageName, attempt: number, prompt: string) {
    if (!target.worktreePath || !target.workspaceId)
      throw new HerdrError('state', 'The run has no workspace yet.');
    const runDirectory = this.runDirectory(target.id);
    const stages = join(runDirectory, 'stages');
    await mkdir(stages, { recursive: true });
    const promptFile = join(stages, `${stage}-${attempt}.prompt.md`);
    const scriptFile = join(stages, `${stage}-${attempt}.sh`);
    await writeFile(promptFile, prompt);
    await writeFile(
      scriptFile,
      launchScript({
        runId: target.id,
        stage,
        attempt,
        worktreePath: target.worktreePath,
        repositoryPath: join(this.config.home, 'repos', target.repo),
        runDirectory,
        promptFile,
        mcpUrl: `${this.config.mcpPublicUrl}/mcp/runs/${target.id}/stages/${stage}`,
        image: this.config.agentImage,
        envFile: join(this.config.home, 'agent.env'),
        ...(this.config.agentDockerArgs ? { dockerArgs: this.config.agentDockerArgs } : {}),
        ...(this.config.agentModel ? { model: this.config.agentModel } : {}),
        ...(this.config.agentCommand ? { agentCommand: this.config.agentCommand } : {}),
      }),
    );
    await chmod(scriptFile, 0o700);
    const tab = await this.client.call<{
      root_pane?: { pane_id: string };
      pane?: { pane_id: string };
    }>('tab.create', {
      workspace_id: target.workspaceId,
      label: attempt > 1 ? `${stage} (${attempt})` : stage,
      cwd: target.worktreePath,
      focus: false,
    });
    const paneId = tab.root_pane?.pane_id ?? tab.pane?.pane_id;
    if (!paneId) throw new HerdrError('protocol', 'Herdr did not return a pane for the new tab.');
    await this.client.call('pane.send_text', {
      pane_id: paneId,
      text: `exec bash ${quote(scriptFile)}\n`,
    });
    return { paneId };
  }

  onExit(listener: (paneId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async isAlive(paneId: string): Promise<boolean> {
    try {
      await this.client.call('pane.get', { pane_id: paneId });
      return true;
    } catch (error) {
      if (error instanceof HerdrError && !['unreachable', 'timeout'].includes(error.code))
        return false;
      throw error;
    }
  }

  async tail(paneId: string, lines: number): Promise<string> {
    const result = await this.client.call<{ read: { text: string } }>('pane.read', {
      pane_id: paneId,
      source: 'recent',
      lines,
      strip_ansi: true,
    });
    return result.read.text;
  }

  async stopStage(paneId: string): Promise<void> {
    await this.client.call('pane.close', { pane_id: paneId }).catch(() => {});
  }

  async removeWorkspace(workspaceId: string): Promise<void> {
    try {
      await this.client.call('worktree.remove', {
        workspace_id: workspaceId,
        force: true,
        trust_repository: true,
      });
    } catch {
      await this.client.call('workspace.close', { workspace_id: workspaceId }).catch(() => {});
    }
  }

  close(): void {
    this.unsubscribe?.();
    this.listeners.clear();
  }
}
