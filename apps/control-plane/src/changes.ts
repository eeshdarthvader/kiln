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

/** A file that two or more unfinished runs of the same repository have both changed. */
export interface Overlap {
  repo: string;
  path: string;
  runIds: string[];
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

  private overlapCache: { at: number; value: Overlap[] } | undefined;

  /** Files touched by more than one unfinished run, which is where merge conflicts come from. */
  async overlaps(): Promise<Overlap[]> {
    if (this.overlapCache && Date.now() - this.overlapCache.at < 15_000)
      return this.overlapCache.value;
    const repository = this.repository;
    const byFile = new Map<string, { repo: string; path: string; runIds: string[] }>();
    if (repository) {
      const active = this.core
        .list()
        .filter(
          (run) =>
            ['queued', 'running', 'needs_input'].includes(run.status) &&
            run.worktreePath &&
            run.baseBranch &&
            existsSync(run.worktreePath),
        );
      await Promise.all(
        active.map(async (run) => {
          try {
            const diff = await repository.patch(run.worktreePath!, `origin/${run.baseBranch}`);
            for (const file of parseDiff(diff).files) {
              const key = `${run.repo}\0${file.path}`;
              const entry = byFile.get(key) ?? { repo: run.repo, path: file.path, runIds: [] };
              entry.runIds.push(run.id);
              byFile.set(key, entry);
            }
          } catch {
            // A worktree that cannot be read just does not take part.
          }
        }),
      );
    }
    const value = [...byFile.values()].filter((entry) => entry.runIds.length > 1);
    this.overlapCache = { at: Date.now(), value };
    return value;
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
