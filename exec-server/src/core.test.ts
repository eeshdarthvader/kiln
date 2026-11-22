import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Core } from './core.ts';
import { FactoryError, branchName } from './domain.ts';
import { FileRunStore, MemoryRunStore } from './store.ts';
import { issue } from './testing.ts';
import { parseIssueUrl } from './validation.ts';

function running(core: Core) {
  const run = core.create(issue());
  core.update(run.id, (draft) => {
    draft.status = 'running';
    draft.stages.push({
      name: 'plan',
      attempt: 1,
      status: 'running',
      paneId: 'p1',
      summary: '',
      startedAt: new Date().toISOString(),
      endedAt: null,
    });
  });
  return run;
}

test('one run per issue, newest first, with a branch derived from the issue', () => {
  const core = new Core(new MemoryRunStore());
  const run = core.create(issue());
  assert.equal(core.create(issue()).id, run.id);
  assert.equal(run.status, 'queued');
  assert.equal(run.branch, 'factory/7-add-a-health-route');
  assert.equal(branchName(3, '  ¡¡ !! '), 'factory/3');
  assert.equal(branchName(3, 'x'.repeat(80)).length, 'factory/3-'.length + 40);
  assert.equal(core.list().length, 1);
  assert.equal('plan' in core.list()[0]!, false);
});

test('agent writes are retry-safe and only accepted from the running stage', () => {
  const core = new Core(new MemoryRunStore());
  const run = running(core);
  const reports: string[] = [];
  core.on('report', (_id, stage, report) => reports.push(`${stage}:${report.status}`));

  const report = {
    status: 'running',
    summary: 'Reading code',
    plan: { steps: [{ id: 'a', text: 'Read', status: 'running' }] },
  };
  const receipt = core.reportStatus(run.id, 'plan', 'op-1', report);
  assert.deepEqual(core.reportStatus(run.id, 'plan', 'op-1', report), receipt);
  assert.deepEqual(reports, ['plan:running'], 'a retried call is not applied twice');
  assert.equal(core.get(run.id).plan.steps[0]?.text, 'Read');
  assert.equal(core.get(run.id).stages[0]?.summary, 'Reading code');

  assert.throws(
    () => core.reportStatus(run.id, 'plan', 'op-1', { status: 'done', summary: 'different' }),
    (error: FactoryError) => error.code === 'IDEMPOTENCY_CONFLICT',
  );
  assert.throws(
    () =>
      core.reportStatus(run.id, 'implement', 'op-2', { status: 'done', summary: 'wrong stage' }),
    (error: FactoryError) => error.code === 'RUN_STATE_CONFLICT',
  );
  assert.throws(
    () => core.reportStatus(run.id, 'deploy', 'op-3', { status: 'done', summary: 'x' }),
    FactoryError,
  );
  assert.throws(() => core.reportStatus(run.id, 'plan', 'op-4', { status: 'done' }), FactoryError);
  assert.throws(
    () => core.get('missing'),
    (error: FactoryError) => error.status === 404,
  );

  const attachment = core.createAttachment(run.id, 'plan', 'att-1', {
    kind: 'decision',
    title: 'Use Express',
    summary: 'Keep the existing router.',
    rationale: 'No new dependency.',
  });
  assert.equal(attachment.stage, 'plan');
  assert.equal(core.get(run.id).attachments.length, 1);
});

test('runs and their applied operations survive a restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'factory-store-'));
  const core = new Core(new FileRunStore(directory));
  const run = running(core);
  const receipt = core.reportStatus(run.id, 'plan', 'op-1', {
    status: 'running',
    summary: 'Working',
  });

  const reloaded = new Core(new FileRunStore(directory));
  assert.equal(reloaded.get(run.id).stages[0]?.summary, 'Working');
  assert.deepEqual(
    reloaded.reportStatus(run.id, 'plan', 'op-1', { status: 'running', summary: 'Working' }),
    receipt,
  );
  reloaded.remove(run.id);
  assert.equal(new Core(new FileRunStore(directory)).list().length, 0);
});

test('issue URLs are parsed strictly', () => {
  assert.deepEqual(parseIssueUrl(' https://github.com/acme/widgets/issues/12 '), {
    repo: 'acme/widgets',
    number: 12,
  });
  assert.deepEqual(parseIssueUrl('https://github.com/a.b/c-d/issues/3#issuecomment-1').number, 3);
  for (const bad of [
    'https://github.com/acme/widgets/pull/12',
    'https://example.com/acme/widgets/issues/12',
    'https://github.com/acme/widgets/issues/12/../../x',
    'acme/widgets#12',
  ])
    assert.throws(() => parseIssueUrl(bad), FactoryError);
});
