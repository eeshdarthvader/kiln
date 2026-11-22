import type { Change, Issue, PrState, Run, StageName } from './domain.ts';

/** Where agents run. Herdr in production, an in-memory fake in tests. */
export interface AgentRuntime {
  /** Directory holding a run's hand-off files (issue, plan, reviews, stage prompts). */
  runDirectory(runId: string): string;
  /** Creates the run's git worktree and the Herdr workspace that shows it. */
  createWorkspace(
    run: Run,
    repositoryPath: string,
  ): Promise<{ worktreePath: string; workspaceId: string }>;
  /** Starts one agent for a stage and returns the pane it runs in. */
  startStage(
    run: Run,
    stage: StageName,
    attempt: number,
    prompt: string,
  ): Promise<{ paneId: string }>;
  /** Calls back once when the pane's process ends or the pane is closed. */
  onExit(listener: (paneId: string) => void): () => void;
  isAlive(paneId: string): Promise<boolean>;
  tail(paneId: string, lines: number): Promise<string>;
  stopStage(paneId: string): Promise<void>;
  removeWorkspace(workspaceId: string): Promise<void>;
  close(): void;
}

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
  /** Clones the repository on first use, fetches afterwards, and returns the local path. */
  syncRepository(repo: string): Promise<string>;
}

/** Reads a run's local git worktree, for the autonomy policy. */
export interface Repository {
  /** A file as it is at `ref` (for example `origin/main`), or null when it does not exist. */
  readFile(worktree: string, ref: string, path: string): Promise<string | null>;
  /** Files changed on the worktree's branch since it left `base`. */
  changes(worktree: string, base: string): Promise<Change[]>;
}
