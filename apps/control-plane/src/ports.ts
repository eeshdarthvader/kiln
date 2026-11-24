import type { Check } from './changes.ts';
import type { Change, Issue, PrState } from './domain.ts';

export type { AgentRuntime } from '@factory/runtime';

/** GitHub access. The `gh` CLI in production. */
export interface GitHub {
  issue(repo: string, number: number): Promise<Issue>;
  labelledIssues(repo: string, label: string): Promise<Issue[]>;
  /** Adds and removes labels in one edit, creating labels that do not exist yet. */
  relabel(repo: string, number: number, add: string[], remove: string[]): Promise<void>;
  comment(repo: string, number: number, body: string): Promise<void>;
  defaultBranch(repo: string): Promise<string>;
  pullRequestForBranch(repo: string, branch: string): Promise<string | null>;
  /** Where a pull request stands on GitHub right now. */
  pullRequestState(prUrl: string): Promise<PrState>;
  /** Marks the pull request ready and merges it, or queues it to merge once checks pass. */
  mergePullRequest(prUrl: string): Promise<void>;
  /** True when GitHub reports the pull request cannot merge because it conflicts with its base. */
  hasConflicts(prUrl: string): Promise<boolean>;
  /** The pull request's full unified diff. */
  pullRequestDiff(prUrl: string): Promise<string>;
  /** CI checks and commit statuses on the pull request's head. */
  pullRequestChecks(prUrl: string): Promise<Check[]>;
  /** Clones the repository on first use, fetches afterwards, and returns the local path. */
  syncRepository(repo: string): Promise<string>;
}

/** An external task tracker (Jira, ...) that supports labels and comments. */
export interface TaskProvider {
  readonly name: string;
  /** Open tickets carrying the label. Each names the GitHub repository to build in. */
  labelled(label: string): Promise<Issue[]>;
  get(key: string): Promise<Issue>;
  /** Adds and removes labels in one edit. */
  relabel(key: string, add: string[], remove: string[]): Promise<void>;
  comment(key: string, body: string): Promise<void>;
  /** The ticket key a pasted URL refers to, or null when it is not this tracker's. */
  parseUrl(url: string): string | null;
}

/** Reads a run's local git worktree, for the autonomy policy. */
export interface Repository {
  /** A file as it is at `ref` (for example `origin/main`), or null when it does not exist. */
  readFile(worktree: string, ref: string, path: string): Promise<string | null>;
  /** Files changed on the worktree's branch since it left `base`. */
  changes(worktree: string, base: string): Promise<Change[]>;
  /** Unified diff of the worktree (committed or not) against where it left `base`. */
  patch(worktree: string, base: string): Promise<string>;
  /** Brings the branch up to date with `origin/<base>`: a clean rebase, or the conflict left for an agent. */
  sync(worktree: string, base: string): Promise<'current' | 'rebased' | 'conflict'>;
}
