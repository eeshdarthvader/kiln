import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { Core } from './core.ts';
import type { Config } from './config.ts';
import type { StageName, StageReport } from './domain.ts';
import { Pipeline } from './pipeline.ts';
import { MemoryRunStore } from './store.ts';
import { FakeGitHub, FakeRuntime, eventually, issue, testConfig } from './testing.ts';

function factory(t: TestContext, overrides: Partial<Config> = {}, store = new MemoryRunStore()) {
  const config = testConfig(overrides);
  const core = new Core(store);
  const runtime = new FakeRuntime(config.home);
  const github = new FakeGitHub();
  const pipeline = new Pipeline(core, runtime, github, config, {
    prompt: (_run, stage, attempt) => `${stage} ${attempt}`,
    exitGraceMs: 10,
    stopDelayMs: 0,
  });
  t.after(() => pipeline.stop());
  let operation = 0;
  /** Reports as the agent of the stage that is running, then waits for the next stage to start. */
  const report = async (runId: string, stage: StageName, value: Partial<StageReport> = {}) => {
    const before = runtime.started.length;
    core.reportStatus(runId, stage, `op-${++operation}`, {
      status: 'done',
      summary: `${stage} ok`,
      ...value,
    });
    return eventually(() => {
      const run = core.get(runId);
      assert.ok(
        run.status !== 'running' || runtime.started.length > before,
        'pipeline did not advance',
      );
      return run;
    });
  };
  const stageRunning = (runId: string, stage: StageName) =>
    eventually(() => {
      const current = core.get(runId).stages.at(-1);
      assert.equal(current?.name, stage);
      assert.equal(current?.status, 'running');
      assert.ok(current?.paneId);
    });
  return { config, core, runtime, github, pipeline, report, stageRunning, store };
}

test('an issue runs through every stage and ends with a pull request', async (t) => {
  const { core, runtime, github, pipeline, report, stageRunning } = factory(t);
  await pipeline.start();
  const run = await pipeline.submit(github.add(issue()));
  await stageRunning(run.id, 'classify');
  assert.deepEqual(github.labels(7), ['factory:in-progress']);
  assert.equal(core.get(run.id).branch, 'factory/7-add-a-health-route');

  for (const stage of ['classify', 'plan', 'plan-review', 'implement', 'review'] as const)
    await report(run.id, stage, stage.endsWith('review') ? { verdict: 'pass' } : {});
  await stageRunning(run.id, 'pr');
  const finished = await report(run.id, 'pr', { prUrl: 'https://github.com/acme/widgets/pull/8' });

  assert.equal(finished.status, 'done');
  assert.equal(finished.prUrl, 'https://github.com/acme/widgets/pull/8');
  assert.deepEqual(
    finished.stages.map((stage) => `${stage.name}:${stage.status}`),
    ['classify:done', 'plan:done', 'plan-review:done', 'implement:done', 'review:done', 'pr:done'],
  );
  assert.deepEqual(github.labels(7), ['factory:done']);
  assert.match(github.comments.at(-1)!.body, /pull\/8/);
  assert.equal(runtime.stopped.length, 6, 'every stage pane is closed');
  assert.equal(runtime.removed.length, 1, 'the worktree is removed once the PR exists');
  assert.equal(finished.worktreePath, null);
});

test('a review asking for changes sends the run back to the reviewed stage', async (t) => {
  const { core, runtime, github, pipeline, report, stageRunning } = factory(t);
  await pipeline.start();
  const run = await pipeline.submit(github.add(issue()));
  await stageRunning(run.id, 'classify');
  await report(run.id, 'classify');
  await report(run.id, 'plan');
  await report(run.id, 'plan-review', {
    verdict: 'changes_requested',
    summary: 'No tests planned.',
  });
  await stageRunning(run.id, 'plan');
  assert.equal(runtime.last.attempt, 2);
  assert.equal(runtime.last.prompt, 'plan 2');
  assert.equal(core.get(run.id).stages.at(-2)?.status, 'changes_requested');
  await report(run.id, 'plan');
  await report(run.id, 'plan-review', { verdict: 'pass' });
  await stageRunning(run.id, 'implement');
});

test('a stage that keeps being rejected fails the run at the attempt limit', async (t) => {
  const { github, pipeline, report, stageRunning } = factory(t, { maxStageAttempts: 2 });
  await pipeline.start();
  const run = await pipeline.submit(github.add(issue()));
  await stageRunning(run.id, 'classify');
  await report(run.id, 'classify');
  await report(run.id, 'plan');
  await report(run.id, 'plan-review', { verdict: 'changes_requested' });
  await report(run.id, 'plan');
  const failed = await report(run.id, 'plan-review', { verdict: 'changes_requested' });
  assert.equal(failed.status, 'failed');
  assert.match(failed.statusReason ?? '', /plan stage did not succeed in 2 attempts/);
  assert.deepEqual(github.labels(7), ['factory:failed']);
});

test('input_required stops the run, asks on the issue, and re-labelling restarts it', async (t) => {
  const { core, runtime, github, pipeline, report, stageRunning } = factory(t);
  await pipeline.start();
  const run = await pipeline.submit(github.add(issue()));
  await stageRunning(run.id, 'classify');
  const stopped = await report(run.id, 'classify', {
    status: 'input_required',
    summary: '1. Which port should it listen on?',
  });
  assert.equal(stopped.status, 'needs_input');
  assert.deepEqual(github.labels(7), ['factory:needs-input']);
  assert.match(github.comments.at(-1)!.body, /Which port/);
  assert.equal(runtime.stopped.length, 1);

  const again = await pipeline.submit(await github.issue('acme/widgets', 7));
  assert.equal(again.id, run.id, 'the same run is reused');
  await stageRunning(run.id, 'classify');
  assert.equal(core.get(run.id).stages.length, 1, 'stage history restarts');
  assert.deepEqual(github.labels(7), ['factory:in-progress']);
});

test('an agent that exits without reporting is restarted, and a late report still counts', async (t) => {
  const { core, runtime, github, pipeline, stageRunning } = factory(t);
  await pipeline.start();
  const run = await pipeline.submit(github.add(issue()));
  await stageRunning(run.id, 'classify');
  runtime.exit(runtime.last.paneId);
  await eventually(() => assert.equal(runtime.started.length, 2));
  assert.equal(runtime.last.stage, 'classify');
  assert.equal(runtime.last.attempt, 2);
  assert.match(core.get(run.id).stages[0]!.summary, /exited without reporting/);

  // The report arrives first, then the pane goes away: that is a normal finish, not a crash.
  core.reportStatus(run.id, 'classify', 'late', { status: 'done', summary: 'ready' });
  runtime.exit(runtime.last.paneId);
  await stageRunning(run.id, 'plan');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(core.get(run.id).stages.at(-1)?.name, 'plan');
  assert.equal(runtime.started.length, 3);
});

test('a failed report fails the run and keeps the worktree for inspection', async (t) => {
  const { runtime, github, pipeline, report, stageRunning } = factory(t);
  await pipeline.start();
  const run = await pipeline.submit(github.add(issue()));
  await stageRunning(run.id, 'classify');
  const failed = await report(run.id, 'classify', {
    status: 'failed',
    summary: 'Not a code change.',
  });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.statusReason, 'classify: Not a code change.');
  assert.equal(runtime.removed.length, 0);
  assert.ok(failed.worktreePath);
});

test('a pr stage without a pull request fails instead of claiming success', async (t) => {
  const { github, pipeline, report, stageRunning } = factory(t);
  await pipeline.start();
  const run = await pipeline.submit(github.add(issue()));
  await stageRunning(run.id, 'classify');
  for (const stage of ['classify', 'plan', 'plan-review', 'implement', 'review'] as const)
    await report(run.id, stage);
  const failed = await report(run.id, 'pr');
  assert.equal(failed.status, 'failed');
  assert.match(failed.statusReason ?? '', /no pull request was found/);
});

test('only maxRuns runs are active; the next starts when one finishes', async (t) => {
  const { core, github, pipeline, report, stageRunning } = factory(t, { maxRuns: 1 });
  await pipeline.start();
  const first = await pipeline.submit(github.add(issue({ number: 1 })));
  const second = await pipeline.submit(
    github.add(issue({ number: 2, url: 'https://github.com/acme/widgets/issues/2' })),
  );
  await stageRunning(first.id, 'classify');
  assert.equal(core.get(second.id).status, 'queued');
  await report(first.id, 'classify', { status: 'failed', summary: 'no' });
  await stageRunning(second.id, 'classify');
});

test('cancel closes the agent, removes the worktree and frees the slot', async (t) => {
  const { runtime, github, pipeline, stageRunning } = factory(t);
  await pipeline.start();
  const run = await pipeline.submit(github.add(issue()));
  await stageRunning(run.id, 'classify');
  const cancelled = await pipeline.cancel(run.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(runtime.stopped, [runtime.last.paneId]);
  assert.equal(runtime.removed.length, 1);
  assert.deepEqual(github.labels(7), []);
  await assert.rejects(pipeline.submit(issue({ state: 'closed' })), /closed/);
});

test('a restart re-attaches to a live agent and restarts a stage whose agent is gone', async (t) => {
  const first = factory(t);
  await first.pipeline.start();
  const live = await first.pipeline.submit(first.github.add(issue({ number: 1 })));
  const gone = await first.pipeline.submit(
    first.github.add(issue({ number: 2, url: 'https://github.com/acme/widgets/issues/2' })),
  );
  await first.stageRunning(live.id, 'classify');
  await first.stageRunning(gone.id, 'classify');
  first.pipeline.stop();

  const second = factory(t, {}, first.store);
  const livePane = second.core.get(live.id).stages[0]!.paneId!;
  second.runtime.alive.add(livePane);
  await second.pipeline.start();
  await eventually(() => assert.equal(second.runtime.started.length, 1));
  assert.equal(second.runtime.last.runId, gone.id);
  assert.equal(second.runtime.last.attempt, 2);
  assert.equal(second.core.get(live.id).stages.length, 1, 'the live stage is left alone');
  await second.report(live.id, 'classify');
  await second.stageRunning(live.id, 'plan');
});

test('a run that cannot start is failed with the reason', async (t) => {
  const { runtime, github, pipeline, core } = factory(t);
  runtime.failNextStart = 'docker is not running';
  await pipeline.start();
  const run = await pipeline.submit(github.add(issue()));
  const failed = await eventually(() => {
    const current = core.get(run.id);
    assert.equal(current.status, 'failed');
    return current;
  });
  assert.match(failed.statusReason ?? '', /docker is not running/);
});
