import assert from 'node:assert/strict';
import test from 'node:test';
import { Core } from './core.ts';
import { SawdError, type PlanStep } from './domain.ts';

function fixture() {
  const core = new Core([
    {
      id: 'agent',
      name: 'Agent',
      description: 'Executor',
      capabilities: [],
      provider: 'opencode',
      instanceId: 'opencode',
      model: 'model',
      workspaceRoot: '/tmp/sawd',
    },
  ]);
  core.accept('task', {
    title: 'Plan task title',
    input: { instructions: 'Implement the change.' },
    acceptanceCriteria: [],
    labels: [],
    executor: 'agent',
  });
  const record = core.record('task');
  return { core, record, taskId: 'task' };
}

const step = (id: string, status: PlanStep['status'] = 'pending'): PlanStep => ({
  id,
  text: `Work on ${id}`,
  status,
});
const report = (steps: PlanStep[]) => ({
  status: 'running',
  summary: 'Making progress.',
  plan: { steps },
});
const status = (code: number) => (error: unknown) =>
  error instanceof SawdError && error.status === code;

test('plans initialize without versions and stay out of initial instructions and summaries', () => {
  const { core } = fixture();
  assert.deepEqual(core.get('task').plan, { steps: [] });
  assert.equal('plan' in core.list()[0]!, false);
  const launch = JSON.parse(core.initialMessage('task'));
  assert.equal('plan' in launch, false);
  assert.equal('workVersion' in launch, false);
  core.get('task').plan.steps.push(step('external'));
  assert.deepEqual(core.get('task').plan, { steps: [] });
});

test('reports atomically replace, reorder, preserve or clear the full plan', () => {
  const { core, taskId } = fixture();
  core.start('task');
  const first = step('first', 'running');
  const second = { ...step('second'), text: '  Second step  ' };
  core.reportStatus(taskId, 'initial', report([first, second]));
  assert.deepEqual(core.get('task').plan, { steps: [first, { ...second, text: 'Second step' }] });
  const revised = [step('second', 'running'), step('first', 'completed')];
  core.reportStatus(taskId, 'reorder', report(revised));
  assert.deepEqual(core.get('task').plan, { steps: revised });
  revised[0]!.text = 'Mutated input';
  core.get('task').plan.steps[0]!.text = 'Mutated output';
  assert.equal(core.get('task').plan.steps[0]!.text, 'Work on second');
  const plan = core.get('task').plan;
  core.reportStatus(taskId, 'summary', { status: 'done', summary: 'Implementation complete.' });
  assert.deepEqual(core.get('task').plan, plan);
  assert.equal(core.get('task').report?.status, 'done');
  core.reportStatus(taskId, 'clear', report([]));
  assert.deepEqual(core.get('task').plan, { steps: [] });
});

test('plan boundaries reject invalid, oversized, duplicate, and unknown fields atomically', () => {
  const { core, record, taskId } = fixture();
  core.start('task');
  const valid = step('first');
  const invalid = [
    null,
    {},
    { expectedRevision: 0, steps: [] },
    { steps: null },
    { steps: [], extra: true },
    { steps: [valid, valid] },
    { steps: [null] },
    { steps: [{ ...valid, extra: true }] },
    { steps: [{ ...valid, status: 'done' }] },
    { steps: [{ id: valid.id, status: valid.status }] },
    { steps: [{ ...valid, text: '   ' }] },
    { steps: [{ ...valid, text: 'x'.repeat(1001) }] },
    { steps: Array.from({ length: 51 }, (_, id) => step(`step-${id}`)) },
    ...['', '../escape', 'a/b', 'a.b', 'x'.repeat(129)].map((id) => ({
      steps: [{ ...valid, id }],
    })),
  ];
  const before = structuredClone(record);
  for (const [index, plan] of invalid.entries()) {
    assert.throws(
      () => core.reportStatus(taskId, `invalid-${index}`, { ...report([]), plan }),
      status(400),
    );
    assert.deepEqual(record, before);
  }
  const bounded = Array.from({ length: 50 }, (_, id) => step(`step-${id}`));
  bounded[0] = { ...valid, id: 'x'.repeat(128), text: 'x'.repeat(1000) };
  core.reportStatus(taskId, 'bounded', report(bounded));
  assert.deepEqual(core.get('task').plan.steps, bounded);
});

test('old report retries preserve the latest plan and reports continue after archival', () => {
  const { core, taskId } = fixture();
  core.start('task');
  const initial = report([step('first')]);
  const receipt = core.reportStatus(taskId, 'initial', initial);
  core.reportStatus(taskId, 'new', report([step('second')]));
  assert.deepEqual(core.reportStatus(taskId, 'initial', initial), receipt);
  assert.deepEqual(core.get('task').plan, { steps: [step('second')] });
  core.archive('task');
  core.reportStatus(taskId, 'archived-update', report([step('third', 'completed')]));
  assert.deepEqual(core.get('task').plan, { steps: [step('third', 'completed')] });
  assert.equal(core.get('task').report?.status, 'running');
});

test('pending setup and rejected reports leave the entire task unchanged', () => {
  const { core, record, taskId } = fixture();
  const before = structuredClone(record);
  assert.throws(() => core.reportStatus(taskId, 'pending', report([])), status(409));
  assert.deepEqual(record, before);
  core.start('task');
  core.reportStatus(taskId, 'saved', report([step('first')]));
  const saved = structuredClone(record);
  assert.throws(() => core.reportStatus(taskId, 'saved', report([step('conflict')])), status(409));
  assert.deepEqual(record, saved);
});
