import type { Core } from './core.ts';
import { parseDiff, type FileChange } from './diff.ts';
import type { GitHub, Repository } from './ports.ts';
import { existsSync } from 'node:fs';

export interface Check {
  name: string;
  state: 'pass' | 'fail' | 'pending' | 'skipped';
  url?: string;
}

export interface Changes {
  /** Where the diff came from: the pull request, the run's own worktree, or nowhere. */
  source: 'pull_request' | 'worktree' | 'none';
  files: FileChange[];
  truncated: boolean;
  checks: Check[];
  note?: string;
}

/** What a run has changed so far, for the dashboard's Changes panel. */
export class ChangesService {
  private readonly core: Core;
  private readonly github: GitHub;
  private readonly repository: Repository | undefined;
  constructor(core: Core, github: GitHub, repository?: Repository) {
    this.core = core;
    this.github = github;
    this.repository = repository;
  }

  async changes(runId: string): Promise<Changes> {
    const run = this.core.get(runId);
    let note: string | undefined;
    if (run.prUrl) {
      try {
        const [diff, checks] = await Promise.all([
          this.github.pullRequestDiff(run.prUrl),
          this.github.pullRequestChecks(run.prUrl).catch(() => []),
        ]);
        return { source: 'pull_request', ...parseDiff(diff), checks };
      } catch (error) {
        note = `The pull request diff could not be loaded: ${(error as Error).message}`;
      }
    }
    if (this.repository && run.worktreePath && run.baseBranch && existsSync(run.worktreePath)) {
      try {
        const diff = await this.repository.patch(run.worktreePath, `origin/${run.baseBranch}`);
        return { source: 'worktree', ...parseDiff(diff), checks: [] };
      } catch (error) {
        note ??= `The worktree diff could not be read: ${(error as Error).message}`;
      }
    }
    return {
      source: 'none',
      files: [],
      truncated: false,
      checks: [],
      note: note ?? 'Nothing has been changed yet.',
    };
  }
}
