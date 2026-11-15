import assert from 'node:assert/strict';
import test from 'node:test';
import { Core } from './core.ts';
import { profiles, SawdError, type AgentProfile } from './domain.ts';

export const profile: AgentProfile = {
  id: 'agent',
  name: 'Agent',
  description: 'Executor',
  capabilities: ['git'],
  provider: 'opencode',
  instanceId: 'opencode',
  model: 'model',
  workspaceRoot: '/tmp/sawd',
};
export const submission = {
  title: 'Implement change',
  input: { instructions: 'Implement the change.' },
  acceptanceCriteria: ['Works'],
  labels: ['demo'],
  executor: 'agent',
};
export function fixture() {
  const core = new Core([profile]);
  core.accept('task', submission);
  return { core, taskId: 'task' };
}
const status = (code: number) => (error: unknown) =>
  error instanceof SawdError && error.status === code;

test('task PUT is idempotent across object key order and conflicts on changed content', () => {
  const { core } = fixture();
  assert.equal(
    core.accept('task', Object.fromEntries(Object.entries(submission).reverse())).created,
    false,
  );
  assert.throws(
    () => core.accept('task', { ...submission, input: { instructions: 'Different' } }),
    status(409),
  );
  assert.equal(core.list().length, 1);
  assert.deepEqual(core.get('task').input, submission.input);
});

test('task titles are required, trimmed, bounded, and part of the accepted definition', () => {
  const core = new Core([profile]);
  const { title, ...untitled } = submission;
  assert.throws(() => core.accept('task', untitled), status(400));
  for (const title of ['', ' \n\t ', 'x'.repeat(201), null, 42])
    assert.throws(() => core.accept('task', { ...submission, title }), status(400));
  assert.equal(core.records.size, 0);
  assert.equal(core.accept('task', { ...submission, title: `  ${title}  ` }).task.title, title);
  assert.equal(core.accept('task', submission).created, false);
  assert.throws(() => core.accept('task', { ...submission, title: 'Different' }), status(409));
  core.start('task');
  assert.equal(JSON.parse(core.initialMessage('task')).title, title);
  assert.equal(core.get('task').title, title);
  assert.equal(
    core.accept('long-title', { ...submission, title: 'x'.repeat(200) }).task.title.length,
    200,
  );
});

test('strict external boundary rejects unsafe IDs, unknown fields, oversized values, and missing executors', () => {
  const { core } = fixture();
  for (const id of ['../escape', 'a/b', 'a.b', '', 'x'.repeat(129)])
    assert.throws(() => core.accept(id, submission), status(400));
  for (const value of [
    { ...submission, path: '/etc/passwd' },
    { ...submission, input: { instructions: 'x'.repeat(20_001) } },
    { ...submission, autonomy: 'guided' },
    { ...submission, initiator: 'tester' },
  ])
    assert.throws(() => core.accept('new', value), status(400));
  assert.throws(() => core.accept('new', { ...submission, executor: 'missing' }), status(404));
});

test('copies isolate public projections and hide runtime bookkeeping', () => {
  const { core } = fixture();
  const task = core.get('task');
  task.acceptanceCriteria.push('mutated');
  const agents = core.listAgents();
  agents[0]!.capabilities.push('docker');
  assert.deepEqual(core.get('task').acceptanceCriteria, ['Works']);
  assert.deepEqual(core.listAgents()[0]!.capabilities, ['git']);
  for (const key of ['threadId', 'workspacePath', 'operations', 'token'])
    assert.equal(key in core.list()[0]!, false);
  assert.ok(!JSON.stringify(core.listAgents()).includes('/tmp'));
  assert.throws(
    () => core.reportStatus('wrong', 'report', { status: 'running', summary: 'Progress' }),
    status(404),
  );
});

test('immutable inline attachments and reporting operations retry safely', () => {
  const { core, taskId } = fixture();
  core.start('task');
  const input = {
    kind: 'artifact',
    title: 'Review',
    content: '# Document',
    mediaType: 'text/markdown',
  };
  const attachment = core.createAttachment(taskId, 'attach', input);
  attachment.title = 'mutated';
  assert.equal(core.createAttachment(taskId, 'attach', input).title, 'Review');
  assert.throws(
    () => core.createAttachment(taskId, 'attach', { ...input, content: 'changed' }),
    status(409),
  );
  assert.throws(
    () => core.createAttachment(taskId, 'unsafe', { ...input, path: '/etc/passwd' }),
    status(400),
  );
  assert.throws(
    () =>
      core.createAttachment(taskId, 'bad-evidence', {
        kind: 'evidence',
        title: 'Bad',
        url: 'file:///etc/passwd',
      }),
    status(400),
  );
  assert.equal(
    core.createAttachment(taskId, 'evidence', {
      kind: 'evidence',
      title: 'Proof',
      url: 'https://example.com/test',
    }).kind,
    'evidence',
  );
});

test('profiles require an available OpenCode provider and expose supported capability inventory', () => {
  const provider = {
    id: 'opencode',
    driver: 'opencode',
    name: 'opencode',
    available: true,
    models: [{ id: 'model', name: 'Model' }],
  };
  assert.equal(profiles([provider], '/tmp', ['git'])[0]!.capabilities[0], 'git');
  assert.equal(profiles([{ ...provider, available: false }], '/tmp', []).length, 0);
  assert.equal(profiles([{ ...provider, driver: 'other' }], '/tmp', []).length, 0);
  assert.equal(profiles([{ ...provider, models: [] }], '/tmp', []).length, 0);
  assert.throws(() => profiles([], undefined, []));
});

test('optional submission arrays normalize to empty arrays for idempotent retries', () => {
  const core = new Core([profile]);
  const { labels: _labels, acceptanceCriteria: _criteria, ...minimal } = submission;
  const accepted = core.accept('task', minimal).task;
  assert.deepEqual(accepted.labels, []);
  assert.deepEqual(accepted.acceptanceCriteria, []);
  assert.equal(
    core.accept('task', { ...minimal, labels: [], acceptanceCriteria: [] }).created,
    false,
  );
});

test('setup and latest report are independent; summaries omit heavy detail', () => {
  const { core, taskId } = fixture();
  const pending = core.get('task');
  assert.deepEqual(pending.setup, { status: 'pending' });
  assert.equal(pending.report, null);
  assert.equal(pending.runtimeUrl, null);
  for (const key of ['status', 'summary', 'workVersion', 'cancellation', 'deadlineAt'])
    assert.equal(key in pending, false);
  core.start('task');
  const initial = JSON.parse(core.initialMessage('task'));
  assert.equal('executionToken' in initial, false);
  assert.equal(initial.taskId, taskId);
  assert.equal('token' in core.record(taskId), false);
  assert.deepEqual(initial.input, submission.input);
  core.reportStatus(taskId, 'early', { status: 'running', summary: 'During initial delivery' });
  const report = core.get('task').report;
  const url = 'https://runtime.example/session/task';
  core.setSetup('task', { status: 'submitted' }, url);
  assert.deepEqual(core.get('task').report, report);
  assert.equal(core.get('task').runtimeUrl, url);
  const summary = core.list()[0]!;
  for (const key of ['input', 'acceptanceCriteria', 'plan', 'attachments'])
    assert.equal(key in summary, false);
  assert.deepEqual(summary.report, report);
  assert.equal(summary.runtimeUrl, url);
  assert.deepEqual(core.start('task'), core.get('task'));
});

test('new reports after completion, failure and archival replace only the latest report', () => {
  const { core, taskId } = fixture();
  const archivedAt = core.archive('task').archivedAt;
  assert.ok(archivedAt);
  core.start('task');
  core.setSetup('task', { status: 'submitted' });
  for (const [index, reportStatus] of [
    'running',
    'input_required',
    'done',
    'running',
    'failed',
    'running',
  ].entries()) {
    const input = { status: reportStatus, summary: `Report ${index}` };
    const receipt = core.reportStatus(taskId, `report-${index}`, input);
    assert.deepEqual(core.get('task').report, { ...input, receivedAt: receipt.receivedAt });
    assert.deepEqual(core.get('task').setup, { status: 'submitted' });
    assert.deepEqual(Object.keys(receipt).sort(), ['operationId', 'receivedAt', 'taskId']);
    assert.equal(core.archive('task').archivedAt, archivedAt);
  }
  core.createAttachment(taskId, 'after-done', {
    kind: 'evidence',
    title: 'Result',
    text: 'Verified',
  });
  assert.equal(core.get('task').attachments.length, 1);
});

test('report retries return original receipts without overwriting newer work or retaining task snapshots', () => {
  const { core, taskId } = fixture();
  core.start('task');
  const done = { status: 'done', summary: 'First request complete' };
  const original = core.reportStatus(taskId, 'done', done);
  core.reportStatus(taskId, 'follow-up', { status: 'running', summary: 'Follow-up' });
  const before = core.get('task');
  assert.deepEqual(core.reportStatus(taskId, 'done', done), original);
  assert.deepEqual(core.get('task'), before);
  assert.deepEqual(core.record('task').operations.get('done')!.result, original);
  const retry = core.reportStatus(taskId, 'done', done);
  retry.receivedAt = 'mutated';
  assert.deepEqual(core.reportStatus(taskId, 'done', done), original);
  assert.throws(
    () => core.reportStatus(taskId, 'done', { ...done, summary: 'Changed' }),
    status(409),
  );
  assert.throws(
    () =>
      core.createAttachment(taskId, 'done', {
        kind: 'evidence',
        title: 'Other tool',
        text: 'Proof',
      }),
    status(409),
  );
  assert.deepEqual(core.get('task'), before);
});

test('reporting requires started setup, including uncertain delivery', () => {
  const { core, taskId } = fixture();
  const report = { status: 'running', summary: 'Progress' };
  for (const setupStatus of ['pending', 'failed'] as const) {
    core.setSetup('task', { status: setupStatus });
    const before = structuredClone(core.record('task'));
    assert.throws(() => core.reportStatus(taskId, setupStatus, report), status(409));
    assert.throws(
      () =>
        core.createAttachment(taskId, setupStatus, {
          kind: 'evidence',
          title: 'Proof',
          text: 'Result',
        }),
      status(409),
    );
    assert.deepEqual(core.record('task'), before);
  }
  for (const setupStatus of ['starting', 'unknown', 'submitted'] as const) {
    core.setSetup('task', { status: setupStatus });
    assert.equal(core.reportStatus(taskId, setupStatus, report).taskId, 'task');
  }
});

test('strict boundaries reject execution control, native context and invalid task IDs', () => {
  const { core, taskId } = fixture();
  core.start('task');
  const report = { status: 'running', summary: 'Progress' };
  assert.throws(() => core.reportStatus('missing', 'report', report), status(404));
  for (const invalid of ['', '../escape', 'a/b', 'x'.repeat(129)])
    assert.throws(() => core.reportStatus(invalid, 'report', report), status(400));
  for (const input of [
    { ...report, workVersion: 1 },
    { ...report, messageId: 'message' },
    { ...report, answers: { scope: 'small' } },
    { ...report, status: 'cancelled' },
    { ...report, plan: { revision: 0, steps: [] } },
  ])
    assert.throws(() => core.reportStatus(taskId, 'invalid', input), status(400));
  assert.throws(
    () => core.accept('deadline', { ...submission, deadlineAt: '2027-01-01T00:00:00Z' }),
    status(400),
  );
  assert.throws(
    () =>
      core.createAttachment(taskId, 'questions', {
        kind: 'questions',
        title: 'Scope',
        questions: [],
      }),
    status(400),
  );
  assert.equal(core.record('task').operations.size, 0);
});

test('reporting and operation IDs stay scoped to the addressed task', () => {
  const { core, taskId } = fixture();
  core.accept('other', submission);
  core.start(taskId);
  core.start('other');
  core.reportStatus(taskId, 'report', { status: 'done', summary: 'Complete' });
  assert.equal(core.get('other').report, null);
  core.reportStatus('other', 'report', { status: 'running', summary: 'Other task' });
  assert.equal(core.get(taskId).report?.status, 'done');
  assert.equal(core.get('other').report?.summary, 'Other task');
});
