import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuration, type Config } from './config.ts';
import type { Change, Issue, PrState, Run, StageName } from './domain.ts';
import type { Check } from './changes.ts';
import type { AgentRuntime, GitHub, Repository } from './ports.ts';

/** Shared fakes for tests. Nothing here talks to Herdr, Docker or GitHub. */
export const testConfig = (overrides: Partial<Config> = {}): Config => ({
  ...configuration({ FACTORY_HOME: mkdtempSync(join(tmpdir(), 'factory-test-')) }),
  repos: ['acme/widgets'],
  ...overrides,
});

export const issue = (overrides: Partial<Issue> = {}): Issue => ({
  repo: 'acme/widgets',
  number: 7,
  title: 'Add a health route',
  body: 'Please add GET /healthz.',
  url: 'https://github.com/acme/widgets/issues/7',
  labels: ['factory'],
  state: 'open',
  ...overrides,
});

export class FakeRuntime implements AgentRuntime {
  readonly started: Array<{
    runId: string;
    stage: StageName;
    attempt: number;
    paneId: string;
    prompt: string;
  }> = [];
  readonly stopped: string[] = [];
  readonly removed: string[] = [];
  readonly alive = new Set<string>();
  failNextStart: string | null = null;
  private readonly listeners = new Set<(paneId: string) => void>();
  private readonly home: string;
  private panes = 0;
  constructor(home: string) {
    this.home = home;
  }
  runDirectory(runId: string) {
    return join(this.home, 'runs-data', runId);
  }
  async createWorkspace(run: Run) {
    return {
      worktreePath: join(this.home, 'worktrees', run.id),
      workspaceId: `w-${run.id.slice(0, 4)}`,
    };
  }
  async startStage(run: Run, stage: StageName, attempt: number, prompt: string) {
    if (this.failNextStart) {
      const message = this.failNextStart;
      this.failNextStart = null;
      throw new Error(message);
    }
    const paneId = `p${++this.panes}`;
    this.alive.add(paneId);
    this.started.push({ runId: run.id, stage, attempt, paneId, prompt });
    return { paneId };
  }
  onExit(listener: (paneId: string) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async isAlive(paneId: string) {
    return this.alive.has(paneId);
  }
  async tail(paneId: string) {
    return `output of ${paneId}`;
  }
  async stopStage(paneId: string) {
    this.alive.delete(paneId);
    this.stopped.push(paneId);
  }
  async removeWorkspace(workspaceId: string) {
    this.removed.push(workspaceId);
  }
  close() {}
  /** Simulates the agent's process ending. */
  exit(paneId: string) {
    this.alive.delete(paneId);
    for (const listener of this.listeners) listener(paneId);
  }
  get last() {
    return this.started.at(-1)!;
  }
}

export class FakeGitHub implements GitHub {
  readonly issues = new Map<string, Issue>();
  readonly comments: Array<{ number: number; body: string }> = [];
  pullRequest: string | null = null;
  failing = false;
  readonly merged: string[] = [];
  /** What `pullRequestState` answers for a pull request URL; draft until told otherwise. */
  readonly prStates = new Map<string, PrState>();
  mergeError: string | null = null;
  /** Pull request URLs that GitHub reports as conflicting. */
  readonly conflicting = new Set<string>();
  async hasConflicts(prUrl: string) {
    return this.conflicting.has(prUrl);
  }
  add(value: Issue) {
    this.issues.set(`${value.repo}#${value.number}`, structuredClone(value));
    return value;
  }
  async issue(repo: string, number: number) {
    const found = this.issues.get(`${repo}#${number}`);
    if (!found) throw new Error('issue not found');
    return structuredClone(found);
  }
  async labelledIssues(repo: string, label: string) {
    if (this.failing) throw new Error('gh is offline');
    return [...this.issues.values()]
      .filter((item) => item.repo === repo && item.state === 'open' && item.labels.includes(label))
      .map((item) => structuredClone(item));
  }
  async relabel(repo: string, number: number, add: string[], remove: string[]) {
    const found = this.issues.get(`${repo}#${number}`);
    if (!found) return;
    found.labels = [
      ...new Set([...found.labels.filter((label) => !remove.includes(label)), ...add]),
    ];
  }
  async comment(_repo: string, number: number, body: string) {
    this.comments.push({ number, body });
  }
  async defaultBranch() {
    return 'main';
  }
  async pullRequestForBranch() {
    return this.pullRequest;
  }
  async mergePullRequest(prUrl: string) {
    if (this.mergeError) throw new Error(this.mergeError);
    this.merged.push(prUrl);
    this.prStates.set(prUrl, 'merged');
  }
  async pullRequestState(prUrl: string): Promise<PrState> {
    return this.prStates.get(prUrl) ?? 'draft';
  }
  /** What `pullRequestDiff` and `pullRequestChecks` answer. */
  prDiff = '';
  prChecks: Check[] = [];
  async pullRequestDiff() {
    return this.prDiff;
  }
  async pullRequestChecks() {
    return this.prChecks;
  }
  async syncRepository(repo: string) {
    return `/repos/${repo}`;
  }
  labels(number: number, repo = 'acme/widgets') {
    return this.issues.get(`${repo}#${number}`)?.labels ?? [];
  }
}

export class FakeRepository implements Repository {
  /** What `patch` answers. */
  patchText = '';
  async patch() {
    return this.patchText;
  }
  /** The policy file's text on the base branch, or null when the repository has none. */
  policy: string | null = null;
  diff: Change[] = [];
  failingRead = false;
  failingDiff = false;
  /** What `sync` answers: the branch is current, rebased cleanly, or conflicts with its base. */
  syncResult: 'current' | 'rebased' | 'conflict' = 'current';
  readonly synced: string[] = [];
  async sync(worktree: string) {
    this.synced.push(worktree);
    return this.syncResult;
  }
  async readFile() {
    if (this.failingRead) throw new Error('git is broken');
    return this.policy;
  }
  async changes() {
    if (this.failingDiff) throw new Error('git is broken');
    return structuredClone(this.diff);
  }
}

/** Waits until `check` stops throwing, for assertions on work that finishes asynchronously. */
export async function eventually<T>(check: () => T | Promise<T>, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await check();
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}
