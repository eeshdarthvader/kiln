import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { FactoryError, type Issue, type PrState } from '../domain.ts';
import type { GitHub } from '../ports.ts';

export type Execute = (command: string, args: string[], input?: string) => Promise<string>;

/** Runs a command without a shell and returns stdout; stderr becomes the error message. */
export const execute: Execute = (command, args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (error) =>
      reject(new FactoryError(`Cannot run ${command}: ${error.message}`, 502)),
    );
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else
        reject(
          new FactoryError(
            `${command} ${args[0] ?? ''} ${args[1] ?? ''} failed: ${stderr.trim().slice(0, 500)}`,
            502,
          ),
        );
    });
    child.stdin.end(input ?? '');
  });

interface RawIssue {
  number: number;
  title: string;
  body: string | null;
  url: string;
  state: string;
  labels: Array<{ name: string }>;
}
const issueFields = 'number,title,body,url,state,labels';
const toIssue = (repo: string, raw: RawIssue): Issue => ({
  repo,
  number: raw.number,
  title: raw.title,
  body: raw.body ?? '',
  url: raw.url,
  labels: raw.labels.map((label) => label.name),
  state: raw.state.toLowerCase() === 'open' ? 'open' : 'closed',
});

/** GitHub through the `gh` CLI, so the factory uses the login the machine already has. */
export class GhCli implements GitHub {
  private readonly run: Execute;
  private readonly reposDirectory: string;
  private readonly knownLabels = new Set<string>();
  constructor(reposDirectory: string, run: Execute = execute) {
    this.reposDirectory = reposDirectory;
    this.run = run;
  }

  async issue(repo: string, number: number): Promise<Issue> {
    const output = await this.run('gh', [
      'issue',
      'view',
      String(number),
      '--repo',
      repo,
      '--json',
      issueFields,
    ]);
    return toIssue(repo, JSON.parse(output) as RawIssue);
  }

  async labelledIssues(repo: string, label: string): Promise<Issue[]> {
    const output = await this.run('gh', [
      'issue',
      'list',
      '--repo',
      repo,
      '--label',
      label,
      '--state',
      'open',
      '--limit',
      '50',
      '--json',
      issueFields,
    ]);
    return (JSON.parse(output) as RawIssue[]).map((raw) => toIssue(repo, raw));
  }

  async relabel(repo: string, number: number, add: string[], remove: string[]): Promise<void> {
    for (const label of add) {
      const key = `${repo}:${label}`;
      if (this.knownLabels.has(key)) continue;
      await this.run('gh', ['label', 'create', label, '--repo', repo, '--force']);
      this.knownLabels.add(key);
    }
    // gh rejects removing a label the issue does not carry, so only remove what is there.
    const present = new Set((await this.issue(repo, number)).labels);
    const removable = remove.filter((label) => present.has(label));
    const args = ['issue', 'edit', String(number), '--repo', repo];
    if (add.length) args.push('--add-label', add.join(','));
    if (removable.length) args.push('--remove-label', removable.join(','));
    if (args.length > 5) await this.run('gh', args);
  }

  async comment(repo: string, number: number, body: string): Promise<void> {
    await this.run(
      'gh',
      ['issue', 'comment', String(number), '--repo', repo, '--body-file', '-'],
      body,
    );
  }

  async defaultBranch(repo: string): Promise<string> {
    const output = await this.run('gh', [
      'repo',
      'view',
      repo,
      '--json',
      'defaultBranchRef',
      '--jq',
      '.defaultBranchRef.name',
    ]);
    const branch = output.trim();
    if (!branch) throw new FactoryError(`${repo} has no default branch yet.`, 502);
    return branch;
  }

  async pullRequestForBranch(repo: string, branch: string): Promise<string | null> {
    const output = await this.run('gh', [
      'pr',
      'list',
      '--repo',
      repo,
      '--head',
      branch,
      '--state',
      'open',
      '--json',
      'url',
      '--jq',
      '.[0].url // ""',
    ]);
    return output.trim() || null;
  }

  async pullRequestState(prUrl: string): Promise<PrState> {
    const output = await this.run('gh', [
      'pr',
      'view',
      prUrl,
      '--json',
      'state,isDraft',
      '--jq',
      '.state + " " + (.isDraft | tostring)',
    ]);
    const [state, draft] = output.trim().split(' ');
    if (state === 'MERGED') return 'merged';
    if (state === 'CLOSED') return 'closed';
    return draft === 'true' ? 'draft' : 'open';
  }

  async hasConflicts(prUrl: string): Promise<boolean> {
    const output = await this.run('gh', [
      'pr',
      'view',
      prUrl,
      '--json',
      'mergeable',
      '--jq',
      '.mergeable',
    ]);
    return output.trim() === 'CONFLICTING';
  }

  async mergePullRequest(prUrl: string): Promise<void> {
    // The pr stage opens a draft; a draft cannot merge.
    await this.run('gh', ['pr', 'ready', prUrl]).catch(() => {});
    try {
      await this.run('gh', ['pr', 'merge', prUrl, '--squash', '--auto']);
      return;
    } catch (error) {
      if (!/auto.?merge|clean status/i.test((error as Error).message)) throw error;
    }
    // The repository has no auto-merge. Merge directly, but only when every check has passed;
    // pending, failing or absent checks leave the pull request for a human.
    try {
      await this.run('gh', ['pr', 'checks', prUrl]);
    } catch {
      throw new FactoryError(
        'Auto-merge is not available here and the checks are not all passing yet. Merge it by hand.',
        502,
      );
    }
    await this.run('gh', ['pr', 'merge', prUrl, '--squash']);
  }

  async syncRepository(repo: string): Promise<string> {
    const path = join(this.reposDirectory, repo);
    if (existsSync(join(path, '.git'))) {
      await this.run('git', ['-C', path, 'fetch', 'origin', '--prune']);
    } else {
      await mkdir(dirname(path), { recursive: true });
      await this.run('gh', ['repo', 'clone', repo, path]);
    }
    return path;
  }
}
