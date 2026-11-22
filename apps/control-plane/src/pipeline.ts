import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from './config.ts';
import type { Core } from './core.ts';
import {
  FactoryError,
  activeStage,
  isTerminal,
  stageNames,
  type Issue,
  type MergeState,
  type Run,
  type StageName,
  type StageReport,
  type StageStatus,
} from './domain.ts';
import { criticalReasons, oneWayDecisions, parsePolicy, policyPath } from './policy.ts';
import type { AgentRuntime, GitHub, Repository } from './ports.ts';
import { issueFile, stagePrompt, type PromptBuilder } from './prompts.ts';

/** A review stage that asks for changes sends the run back to the stage it reviewed. */
const reviews: Partial<Record<StageName, StageName>> = {
  'plan-review': 'plan',
  review: 'implement',
};

export interface PipelineOptions {
  prompt?: PromptBuilder;
  /** How long to wait for a late report after an agent's pane exits. */
  exitGraceMs?: number;
  /** Reads worktrees for the autonomy policy. Without it every run uses the default autonomy. */
  repository?: Repository;
  /** Delay before closing a finished stage's pane, so the agent receives its tool result. */
  stopDelayMs?: number;
}

/**
 * Drives each run through the stages. It reacts to three things: an agent's report, an agent's
 * pane exiting, and a stage timing out. Everything touching one run is serialised.
 */
export class Pipeline {
  private readonly core: Core;
  private readonly runtime: AgentRuntime;
  private readonly github: GitHub;
  private readonly config: Config;
  private readonly prompt: PromptBuilder;
  private readonly repository: Repository | undefined;
  private readonly exitGraceMs: number;
  private readonly stopDelayMs: number;
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly starting = new Set<string>();
  private detach: Array<() => void> = [];

  constructor(
    core: Core,
    runtime: AgentRuntime,
    github: GitHub,
    config: Config,
    options: PipelineOptions = {},
  ) {
    this.core = core;
    this.runtime = runtime;
    this.github = github;
    this.config = config;
    this.prompt = options.prompt ?? stagePrompt;
    this.repository = options.repository;
    this.exitGraceMs = options.exitGraceMs ?? 3000;
    this.stopDelayMs = options.stopDelayMs ?? 1500;
  }

  /** Starts listening and picks up runs that were in flight when the server last stopped. */
  async start(): Promise<void> {
    const onReport = (runId: string, stage: StageName, report: StageReport) =>
      void this.serial(runId, () => this.handleReport(runId, stage, report));
    this.core.on('report', onReport);
    this.detach.push(() => this.core.off('report', onReport));
    this.detach.push(this.runtime.onExit((paneId) => this.handleExit(paneId)));
    for (const run of this.core.list())
      if (run.status === 'running') await this.serial(run.id, () => this.resume(run.id));
    this.pump();
  }

  stop(): void {
    for (const detach of this.detach) detach();
    this.detach = [];
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /** Queues a run for an issue, or restarts the issue's stopped run. */
  async submit(issue: Issue): Promise<Run> {
    if (issue.state !== 'open') throw new FactoryError('The issue is closed.', 409);
    const existing = this.core.findByIssue(issue.repo, issue.number);
    const run =
      existing && existing.status !== 'done'
        ? existing
        : existing
          ? (() => {
              throw new FactoryError('This issue already has a finished run.', 409, 'RUN_EXISTS', {
                runId: existing.id,
              });
            })()
          : this.core.create(issue);
    if (run.status === 'queued' || run.status === 'running') {
      this.pump();
      return run;
    }
    return this.retry(run.id);
  }

  /** Runs a stopped run again from the first stage, keeping the same branch name. */
  async retry(runId: string): Promise<Run> {
    return this.serial(runId, async () => {
      const run = this.core.get(runId);
      if (run.status === 'queued' || run.status === 'running')
        throw new FactoryError('The run is already active.', 409);
      if (run.status === 'done')
        throw new FactoryError('The run already produced a pull request.', 409);
      await this.dropWorkspace(runId);
      const queued = this.core.update(runId, (draft) => {
        draft.status = 'queued';
        draft.statusReason = null;
        draft.stages = [];
        draft.plan = { steps: [] };
        draft.approval = null;
        draft.policy = null;
        draft.merge = null;
        draft.prState = null;
      });
      this.pump();
      return queued;
    });
  }

  /** A human accepts what the policy held back; the run continues with the next stage. */
  async approve(runId: string): Promise<Run> {
    return this.serial(runId, async () => {
      const run = this.core.get(runId);
      if (run.status !== 'needs_input' || !run.approval)
        throw new FactoryError('This run is not waiting for approval.', 409);
      const { after } = run.approval;
      const updated = this.core.update(runId, (draft) => {
        draft.status = 'running';
        draft.statusReason = null;
        draft.approval = null;
        if (draft.policy && after === 'review') draft.policy.approved = true;
      });
      this.core.note(runId, after, {
        kind: 'decision',
        title: 'Approved by a human',
        summary: `A human approved the run after ${after}.`,
        rationale: run.approval.reasons.join('\n'),
      });
      await this.notify(updated, ['in-progress'], ['needs-input'], null);
      await this.startStage(runId, stageNames[stageNames.indexOf(after) + 1]!);
      return this.core.get(runId);
    });
  }

  /** A human overrides: the feedback goes to the stage that produced the work, which runs again. */
  async reject(runId: string, feedback: string): Promise<Run> {
    return this.serial(runId, async () => {
      const run = this.core.get(runId);
      if (run.status !== 'needs_input' || !run.approval)
        throw new FactoryError('This run is not waiting for approval.', 409);
      const { after } = run.approval;
      const back = reviews[after];
      if (!back) throw new FactoryError(`Nothing can be sent back from ${after}.`, 409);
      const directory = this.runtime.runDirectory(runId);
      await mkdir(directory, { recursive: true });
      await appendFile(
        join(directory, 'human-feedback.md'),
        `## After ${after}\n\n${feedback}\n\n`,
      );
      const updated = this.core.update(runId, (draft) => {
        draft.status = 'running';
        draft.statusReason = null;
        draft.approval = null;
        if (draft.policy) draft.policy.approved = false;
      });
      this.core.note(runId, after, {
        kind: 'decision',
        title: 'Overridden by a human',
        summary: `A human sent the run back to ${back}.`,
        rationale: feedback,
      });
      await this.notify(updated, ['in-progress'], ['needs-input'], null);
      await this.startStage(runId, back);
      return this.core.get(runId);
    });
  }

  async cancel(runId: string): Promise<Run> {
    return this.serial(runId, async () => {
      const run = this.core.get(runId);
      if (isTerminal(run.status)) return run;
      await this.closeStage(runId, 'failed', 'Cancelled.', 0);
      const cancelled = this.core.update(runId, (draft) => {
        draft.status = 'cancelled';
        draft.statusReason = 'Cancelled from the dashboard.';
      });
      await this.dropWorkspace(runId);
      await this.notify(cancelled, [], ['in-progress'], null);
      this.pump();
      return cancelled;
    });
  }

  /** Recent terminal output of the stage that is running, or of the last one that ran. */
  async tail(runId: string, lines = 80): Promise<{ stage: StageName | null; text: string }> {
    const run = this.core.get(runId);
    const stage = activeStage(run) ?? run.stages.at(-1);
    if (!stage?.paneId) return { stage: stage?.name ?? null, text: '' };
    try {
      return { stage: stage.name, text: await this.runtime.tail(stage.paneId, lines) };
    } catch {
      return { stage: stage.name, text: '' };
    }
  }

  // ----- run lifecycle ---------------------------------------------------------------------

  private pump(): void {
    const runs = this.core.list();
    let active =
      runs.filter((run) => run.status === 'running' && !this.starting.has(run.id)).length +
      this.starting.size;
    const queued = runs
      .filter((run) => run.status === 'queued' && !this.starting.has(run.id))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const run of queued) {
      if (active >= this.config.maxRuns) break;
      active += 1;
      this.starting.add(run.id);
      void this.serial(run.id, () => this.begin(run.id)).finally(() =>
        this.starting.delete(run.id),
      );
    }
  }

  private async begin(runId: string): Promise<void> {
    if (this.core.get(runId).status !== 'queued') return;
    let run = this.core.update(runId, (draft) => {
      draft.status = 'running';
    });
    try {
      await this.notify(run, ['in-progress'], ['', 'needs-input', 'failed'], null);
      const issue = await this.github.issue(run.repo, run.issueNumber);
      const baseBranch = await this.github.defaultBranch(run.repo);
      const repositoryPath = await this.github.syncRepository(run.repo);
      run = this.core.update(runId, (draft) => {
        draft.baseBranch = baseBranch;
        draft.title = issue.title;
      });
      const workspace = await this.runtime.createWorkspace(run, repositoryPath);
      run = this.core.update(runId, (draft) => {
        draft.worktreePath = workspace.worktreePath;
        draft.workspaceId = workspace.workspaceId;
      });
      const directory = this.runtime.runDirectory(runId);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'issue.md'), issueFile(run, issue.body));
      await this.startStage(runId, stageNames[0]);
    } catch (error) {
      await this.fail(runId, `Could not start the run: ${(error as Error).message}`);
    }
  }

  private async resume(runId: string): Promise<void> {
    const stage = activeStage(this.core.get(runId));
    if (!stage) {
      await this.fail(runId, 'The server stopped before the first stage started.');
      return;
    }
    if (stage.paneId && (await this.runtime.isAlive(stage.paneId).catch(() => false))) {
      this.arm(runId, stage.name, stage.attempt);
      return;
    }
    await this.closeStage(runId, 'failed', 'The agent was gone when the server restarted.', 0);
    await this.startStage(runId, stage.name);
  }

  private async startStage(runId: string, name: StageName): Promise<void> {
    const run = this.core.get(runId);
    const attempt = run.stages.filter((stage) => stage.name === name).length + 1;
    if (attempt > this.config.maxStageAttempts) {
      await this.fail(
        runId,
        `The ${name} stage did not succeed in ${this.config.maxStageAttempts} attempts.`,
      );
      return;
    }
    const started = this.core.update(runId, (draft) => {
      draft.stages.push({
        name,
        attempt,
        status: 'running',
        paneId: null,
        summary: '',
        startedAt: new Date().toISOString(),
        endedAt: null,
      });
    });
    try {
      const prompt = this.prompt(started, name, attempt, this.runtime.runDirectory(runId));
      const { paneId } = await this.runtime.startStage(started, name, attempt, prompt);
      this.core.update(runId, (draft) => {
        const stage = activeStage(draft);
        if (stage) stage.paneId = paneId;
      });
      this.arm(runId, name, attempt);
    } catch (error) {
      await this.closeStage(
        runId,
        'failed',
        `Could not start the agent: ${(error as Error).message}`,
        0,
      );
      await this.fail(runId, `Could not start the ${name} agent: ${(error as Error).message}`);
    }
  }

  private async handleReport(runId: string, name: StageName, report: StageReport): Promise<void> {
    const run = this.core.get(runId);
    const stage = activeStage(run);
    if (run.status !== 'running' || stage?.name !== name) return;
    if (report.status === 'running') return;
    if (report.status === 'failed') {
      await this.closeStage(runId, 'failed', report.summary);
      await this.fail(runId, `${name}: ${report.summary}`);
      return;
    }
    if (report.status === 'input_required') {
      await this.closeStage(runId, 'needs_input', report.summary);
      const stopped = this.core.update(runId, (draft) => {
        draft.status = 'needs_input';
        draft.statusReason = report.summary;
      });
      await this.notify(
        stopped,
        ['needs-input'],
        ['in-progress'],
        `The factory needs input before it can continue (stage: ${name}).\n\n${report.summary}\n\n` +
          `Answer here, then add the \`${this.config.label}\` label again to restart the run.`,
      );
      this.pump();
      return;
    }
    const reviewed = reviews[name];
    if (reviewed && report.verdict === 'changes_requested') {
      await this.closeStage(runId, 'changes_requested', report.summary);
      await this.startStage(runId, reviewed);
      return;
    }
    await this.closeStage(runId, 'done', report.summary);
    const next = stageNames[stageNames.indexOf(name) + 1];
    if (next) {
      if (await this.gate(runId, name, report)) return;
      await this.startStage(runId, next);
      return;
    }
    const prUrl =
      report.prUrl ??
      (await this.github.pullRequestForBranch(run.repo, run.branch).catch(() => null));
    if (!prUrl) {
      await this.fail(runId, 'The pr stage finished but no pull request was found for the branch.');
      return;
    }
    const merged = await this.merge(runId, prUrl);
    const prState = await this.github.pullRequestState(prUrl).catch(() => null);
    const finished = this.core.update(runId, (draft) => {
      draft.status = 'done';
      draft.prUrl = prUrl;
      draft.merge = merged.state;
      draft.prState = prState ?? 'draft';
    });
    await this.dropWorkspace(runId);
    await this.notify(
      finished,
      ['done'],
      ['in-progress'],
      `The factory opened a pull request: ${prUrl}${merged.note ? `\n\n${merged.note}` : ''}`,
    );
    this.pump();
  }

  /**
   * The autonomy policy. After `review` (and after `plan-review` at L0) it decides whether a
   * human must approve before the run goes on. Returns true when the run was paused.
   */
  private async gate(runId: string, name: StageName, report: StageReport): Promise<boolean> {
    if (name !== 'plan-review' && name !== 'review') return false;
    const run = this.core.get(runId);
    const policy = await this.policyFor(run);
    let critical: string[] = [];
    if (name === 'review')
      critical = [
        ...(await this.changeReasons(run, policy)),
        ...oneWayDecisions(run),
        // A reviewer may raise the stakes; it can never lower what the rules found.
        ...(report.risk === 'high'
          ? [`Reviewer flagged a significant logic change: ${report.riskReason ?? report.summary}`]
          : []),
      ];
    this.core.update(runId, (draft) => {
      draft.policy = { autonomy: policy.autonomy, critical, approved: false };
    });
    const reasons =
      policy.autonomy === 'L0'
        ? [`Autonomy L0: every step needs approval (after ${name}).`, ...critical]
        : policy.autonomy === 'L2'
          ? critical
          : [];
    if (!reasons.length) return false;
    const stopped = this.core.update(runId, (draft) => {
      draft.status = 'needs_input';
      draft.statusReason = `Approval needed after ${name}:\n\n${reasons.map((reason) => `- ${reason}`).join('\n')}`;
      draft.approval = { after: name, reasons, requestedAt: new Date().toISOString() };
    });
    await this.notify(
      stopped,
      ['needs-input'],
      ['in-progress'],
      `The factory is waiting for approval after the ${name} stage:\n\n${reasons.map((reason) => `- ${reason}`).join('\n')}\n\nApprove or send it back from the dashboard.`,
    );
    this.pump();
    return true;
  }

  private async policyFor(run: Run) {
    const fallback = this.config.autonomy;
    if (!this.repository || !run.worktreePath || !run.baseBranch)
      return parsePolicy(null, fallback);
    try {
      return parsePolicy(
        await this.repository.readFile(run.worktreePath, `origin/${run.baseBranch}`, policyPath),
        fallback,
      );
    } catch (error) {
      return {
        ...parsePolicy(null, fallback),
        autonomy: fallback === 'L0' ? ('L0' as const) : ('L1' as const),
        problem: `Could not read ${policyPath}: ${(error as Error).message}`,
      };
    }
  }

  private async changeReasons(run: Run, policy: Awaited<ReturnType<typeof this.policyFor>>) {
    if (!this.repository || !run.worktreePath || !run.baseBranch)
      return criticalReasons(policy, []);
    try {
      return criticalReasons(
        policy,
        await this.repository.changes(run.worktreePath, `origin/${run.baseBranch}`),
      );
    } catch (error) {
      // Fail closed: if the diff cannot be read, the change is treated as critical.
      return [`Could not read the diff to check the policy: ${(error as Error).message}`];
    }
  }

  /** At L2 and L3 the factory merges its own pull request, unless a rule held it back. */
  private async merge(
    runId: string,
    prUrl: string,
  ): Promise<{ state: MergeState | null; note: string }> {
    const policy = this.core.get(runId).policy;
    if (!policy || (policy.autonomy !== 'L2' && policy.autonomy !== 'L3'))
      return { state: null, note: '' };
    if (policy.autonomy === 'L2' && policy.critical.length && !policy.approved)
      return {
        state: 'held',
        note: `Not merged: critical change.\n${policy.critical.map((reason) => `- ${reason}`).join('\n')}`,
      };
    try {
      await this.github.mergePullRequest(prUrl);
    } catch (error) {
      return {
        state: 'failed',
        note: `Auto-merge did not go through: ${(error as Error).message}`,
      };
    }
    const flagged =
      policy.autonomy === 'L3' && policy.critical.length
        ? `\n\nCritical changes merged without approval (autonomy L3):\n${policy.critical.map((reason) => `- ${reason}`).join('\n')}`
        : '';
    return {
      state: 'requested',
      note: `Auto-merge requested (autonomy ${policy.autonomy}).${flagged}`,
    };
  }

  private handleExit(paneId: string): void {
    const run = this.core
      .list()
      .find(
        (candidate) => candidate.status === 'running' && activeStage(candidate)?.paneId === paneId,
      );
    if (!run) return;
    // A report can land just after the pane goes away; give it a moment before calling it a crash.
    const timer = setTimeout(
      () =>
        void this.serial(run.id, async () => {
          const stage = activeStage(this.core.get(run.id));
          if (stage?.paneId !== paneId) return;
          await this.closeStage(
            run.id,
            'failed',
            'The agent exited without reporting a result.',
            0,
          );
          await this.startStage(run.id, stage.name);
        }),
      this.exitGraceMs,
    );
    timer.unref();
  }

  private arm(runId: string, name: StageName, attempt: number): void {
    clearTimeout(this.timers.get(runId));
    const timer = setTimeout(
      () =>
        void this.serial(runId, async () => {
          const stage = activeStage(this.core.get(runId));
          if (stage?.name !== name || stage.attempt !== attempt) return;
          await this.closeStage(
            runId,
            'failed',
            `Timed out after ${this.config.stageTimeoutMinutes} minutes.`,
            0,
          );
          await this.startStage(runId, name);
        }),
      this.config.stageTimeoutMinutes * 60_000,
    );
    timer.unref();
    this.timers.set(runId, timer);
  }

  /** Marks the running stage finished and closes its pane. */
  private async closeStage(
    runId: string,
    status: StageStatus,
    summary: string,
    stopDelayMs = this.stopDelayMs,
  ): Promise<void> {
    clearTimeout(this.timers.get(runId));
    this.timers.delete(runId);
    const stage = activeStage(this.core.get(runId));
    if (!stage) return;
    this.core.update(runId, (draft) => {
      const current = activeStage(draft);
      if (!current) return;
      current.status = status;
      current.summary = summary || current.summary;
      current.endedAt = new Date().toISOString();
    });
    const paneId = stage.paneId;
    if (!paneId) return;
    if (stopDelayMs === 0) await this.runtime.stopStage(paneId).catch(() => {});
    else setTimeout(() => void this.runtime.stopStage(paneId).catch(() => {}), stopDelayMs).unref();
  }

  private async fail(runId: string, reason: string): Promise<void> {
    await this.closeStage(runId, 'failed', reason, 0);
    const failed = this.core.update(runId, (draft) => {
      draft.status = 'failed';
      draft.statusReason = reason;
    });
    await this.notify(failed, ['failed'], ['in-progress'], `The factory run failed.\n\n${reason}`);
    this.pump();
  }

  private async dropWorkspace(runId: string): Promise<void> {
    const { workspaceId } = this.core.get(runId);
    if (!workspaceId) return;
    await this.runtime.removeWorkspace(workspaceId).catch(() => {});
    this.core.update(runId, (draft) => {
      draft.workspaceId = null;
      draft.worktreePath = null;
    });
  }

  /**
   * Mirrors run state onto the issue. State labels are `<label>:<state>`; an empty state name
   * means the trigger label itself. GitHub being unreachable never stops a run.
   */
  private async notify(
    run: Run,
    add: string[],
    remove: string[],
    comment: string | null,
  ): Promise<void> {
    const name = (state: string) => (state ? `${this.config.label}:${state}` : this.config.label);
    try {
      await this.github.relabel(run.repo, run.issueNumber, add.map(name), remove.map(name));
      if (comment) await this.github.comment(run.repo, run.issueNumber, comment);
    } catch (error) {
      console.error(`Could not update ${run.repo}#${run.issueNumber}: ${(error as Error).message}`);
    }
  }

  private serial<T>(runId: string, task: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(runId) ?? Promise.resolve()).then(task, task);
    const settled = next.catch(() => {});
    this.queues.set(runId, settled);
    void settled.then(() => {
      if (this.queues.get(runId) === settled) this.queues.delete(runId);
    });
    return next;
  }
}
