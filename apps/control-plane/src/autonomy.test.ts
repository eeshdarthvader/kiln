import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { Config } from './config.ts';
import { Core } from './core.ts';
import type { StageName, StageReport } from './domain.ts';
import { Pipeline } from './pipeline.ts';
import { MemoryRunStore } from './store.ts';
import {
  FakeGitHub,
  FakeRepository,
  FakeRuntime,
  eventually,
  issue,
  testConfig,
} from './testing.ts';

const PR = 'https://github.com/acme/widgets/pull/8';

function factory(t: TestContext, overrides: Partial<Config> = {}) {
  const config = testConfig(overrides);
  const core = new Core(new MemoryRunStore());
  const runtime = new FakeRuntime(config.home);
  const github = new FakeGitHub();
  const repository = new FakeRepository();
  const pipeline = new Pipeline(core, runtime, github, config, {
    prompt: (_run, stage, attempt) => `${stage} ${attempt}`,
    exitGraceMs: 10,
    stopDelayMs: 0,
    repository,
  });
  t.after(() => pipeline.stop());
  let operation = 0;
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
    });
  /** Runs the stages up to and including `review`, which passes. */
  const through = async (runId: string, last: StageName = 'review') => {
    await stageRunning(runId, 'classify');
    for (const stage of ['classify', 'plan', 'plan-review', 'implement', 'review'] as const) {
      const run = await report(runId, stage, stage.endsWith('review') ? { verdict: 'pass' } : {});
      if (stage === last) return run;
    }
    throw new Error('unreachable');
  };
  return { config, core, runtime, github, repository, pipeline, report, stageRunning, through };
}

const policy = (value: object) => JSON.stringify(value);

test('L1 opens the pull request and leaves the merge to a human', async (t) => {
  const { github, repository, pipeline, report, stageRunning, through } = factory(t);
  repository.policy = policy({ autonomy: 'L1', critical: { paths: ['**'] } });
  await pipeline.start();
  const run = await pipeline.submit(github.add(issue()));
  await through(run.id);
  await stageRunning(run.id, 'pr');
  const done = await report(run.id, 'pr', { prUrl: PR });
  assert.equal(done.status, 'done');
  assert.equal(done.merge, null);
  assert.deepEqual(github.merged, []);
});

test('L2 merges a change that matches no critical rule', async (t) => {
  const { github, repository, pipeline, report, stageRunning, through } = factory(t);
  repository.policy = policy({ autonomy: 'L2', critical: { paths: ['src/auth/**'] } });
  repository.diff = [{ path: 'src/health.ts', added: 5, deleted: 0 }];
  await pipeline.start();
  const run = await pipeline.submit(github.add(issue()));
  await through(run.id);
  await stageRunning(run.id, 'pr');
  const done = await report(run.id, 'pr', { prUrl: PR });
  assert.equal(done.status, 'done');
  assert.equal(done.merge, 'requested');
  assert.deepEqual(github.merged, [PR]);
  assert.match(github.comments.at(-1)!.body, /Auto-merge requested \(autonomy L2\)/);
});

test('L2 pauses a critical change; approving continues and merges', async (t) => {
  const { core, github, repository, pipeline, report, stageRunning, through } = factory(t);
  repository.policy = policy({ autonomy: 'L2', critical: { paths: ['src/auth/**'] } });
  repository.diff = [{ path: 'src/auth/login.ts', added: 5, deleted: 1 }];
  await pipeline.start();
  const run = await pipeline.submit(github.add(issue()));
  const paused = await through(run.id);
  assert.equal(paused.status, 'needs_input');
  assert.equal(paused.approval?.after, 'review');
  assert.match(paused.approval!.reasons[0]!, /protected paths: src\/auth\/login.ts/);
  assert.deepEqual(github.labels(7), ['factory:needs-input']);
  assert.match(github.comments.at(-1)!.body, /waiting for approval/);

  const approved = await pipeline.approve(run.id);
  assert.equal(approved.status, 'running');
  assert.equal(approved.approval, null);
  await stageRunning(run.id, 'pr');
  assert.equal(core.get(run.id).attachments.at(-1)?.title, 'Approved by a human');
  const done = await report(run.id, 'pr', { prUrl: PR });
  assert.equal(done.merge, 'requested');
  assert.deepEqual(github.merged, [PR]);
});

test('a one-way decision makes the change critical', async (t) => {
  const { core, github, repository, pipeline, through } = factory(t);
  repository.policy = policy({ autonomy: 'L2' });
  await pipeline.start();
  const run = await pipeline.submit(github.add(issue()));
  await eventually(() => assert.equal(core.get(run.id).stages.length, 1));
  core.note(run.id, 'plan', {
    kind: 'decision',
    title: 'Drop the legacy table',
    summary: 'Remove it.',
    rationale: 'Unused.',
    reversibility: 'one_way',
  });
  const paused = await through(run.id);
  assert.equal(paused.status, 'needs_input');
  assert.deepEqual(paused.approval?.reasons, ['One-way decision: Drop the legacy table']);
});

test('rejecting sends the feedback back to implement', async (t) => {
  const { core, runtime, github, repository, pipeline, stageRunning, through } = factory(t);
  repository.policy = policy({ autonomy: 'L2', critical: { paths: ['src/auth/**'] } });
  repository.diff = [{ path: 'src/auth/login.ts', added: 5, deleted: 1 }];
  await pipeline.start();
  const run = await pipeline.submit(github.add(issue()));
  await through(run.id);
  const back = await pipeline.reject(run.id, 'Keep the old session cookie name.');
  assert.equal(back.status, 'running');
  await stageRunning(run.id, 'implement');
  assert.equal(runtime.last.attempt, 2);
  assert.match(
    await readFile(join(runtime.runDirectory(run.id), 'human-feedback.md'), 'utf8'),
    /old session cookie/,
  );
  const note = core.get(run.id).attachments.at(-1)!;
  assert.equal(note.title, 'Overridden by a human');
  await assert.rejects(pipeline.approve(run.id), /not waiting for approval/);
});

test('L3 merges a critical change without asking and says so', async (t) => {
  const { github, repository, pipeline, report, stageRunning, through } = factory(t);
  repository.policy = policy({ autonomy: 'L3', critical: { paths: ['src/auth/**'] } });
  repository.diff = [{ path: 'src/auth/login.ts', added: 5, deleted: 1 }];
  await pipeline.start();
  const run = await pipeline.submit(github.add(issue()));
  await through(run.id);
  await stageRunning(run.id, 'pr');
  const done = await report(run.id, 'pr', { prUrl: PR });
  assert.equal(done.merge, 'requested');
  assert.match(github.comments.at(-1)!.body, /merged without approval \(autonomy L3\)/);
});

test('L0 asks for approval after the plan review and again after the review', async (t) => {
  const { github, repository, pipeline, report, stageRunning } = factory(t);
  repository.policy = policy({ autonomy: 'L0' });
  await pipeline.start();
  const run = await pipeline.submit(github.add(issue()));
  await stageRunning(run.id, 'classify');
  await report(run.id, 'classify');
  await report(run.id, 'plan');
  const first = await report(run.id, 'plan-review', { verdict: 'pass' });
  assert.equal(first.approval?.after, 'plan-review');
  await pipeline.approve(run.id);
  await stageRunning(run.id, 'implement');
  await report(run.id, 'implement');
  const second = await report(run.id, 'review', { verdict: 'pass' });
  assert.equal(second.approval?.after, 'review');
  await pipeline.approve(run.id);
  await stageRunning(run.id, 'pr');
  const done = await report(run.id, 'pr', { prUrl: PR });
  assert.equal(done.merge, null, 'L0 never merges');
});

test('an unreadable diff fails closed at L2', async (t) => {
  const { github, repository, pipeline, through } = factory(t);
  repository.policy = policy({ autonomy: 'L2' });
  repository.failingDiff = true;
  await pipeline.start();
  const run = await pipeline.submit(github.add(issue()));
  const paused = await through(run.id);
  assert.equal(paused.status, 'needs_input');
  assert.match(paused.approval!.reasons[0]!, /Could not read/);
});

test('an unreadable policy drops to L1: a draft PR and no merge', async (t) => {
  const { github, repository, pipeline, report, stageRunning, through } = factory(t, {
    autonomy: 'L3',
  });
  repository.failingRead = true;
  await pipeline.start();
  const run = await pipeline.submit(github.add(issue()));
  await through(run.id);
  await stageRunning(run.id, 'pr');
  const done = await report(run.id, 'pr', { prUrl: PR });
  assert.equal(done.merge, null);
  assert.deepEqual(github.merged, []);
});

test('a failed merge is reported and the run still finishes', async (t) => {
  const { github, repository, pipeline, report, stageRunning, through } = factory(t);
  repository.policy = policy({ autonomy: 'L2' });
  github.mergeError = 'branch protection requires a review';
  await pipeline.start();
  const run = await pipeline.submit(github.add(issue()));
  await through(run.id);
  await stageRunning(run.id, 'pr');
  const done = await report(run.id, 'pr', { prUrl: PR });
  assert.equal(done.status, 'done');
  assert.equal(done.merge, 'failed');
  assert.match(github.comments.at(-1)!.body, /did not go through: branch protection/);
});

test('without a policy file the default autonomy applies', async (t) => {
  const { github, pipeline, report, stageRunning, through } = factory(t, { autonomy: 'L2' });
  await pipeline.start();
  const run = await pipeline.submit(github.add(issue()));
  await through(run.id);
  await stageRunning(run.id, 'pr');
  const done = await report(run.id, 'pr', { prUrl: PR });
  assert.equal(done.merge, 'requested');
});
