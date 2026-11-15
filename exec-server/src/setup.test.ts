import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Core } from './core.ts';
import type { AgentProfile } from './domain.ts';
import {
  RuntimeCommandError,
  type PreparedCommand,
  type RuntimeCommand,
  type RuntimePort,
} from './ports.ts';
import { TaskInitializer } from './setup.ts';

const agent: AgentProfile = {
  id: 'agent',
  name: 'Agent',
  description: '',
  capabilities: [],
  provider: 'opencode',
  instanceId: 'provider',
  model: 'selected',
  workspaceRoot: '/tmp/sawd',
};
function fixture() {
  const core = new Core([agent]);
  core.accept('task', {
    title: 'Task',
    executor: agent.id,
    input: { instructions: 'Implement' },
    acceptanceCriteria: [],
    labels: [],
  });
  const calls: string[] = [];
  const commands: RuntimeCommand[] = [];
  const deliveries: PreparedCommand[] = [];
  const reconciliations: PreparedCommand[] = [];
  const runtime: RuntimePort = {
    async discover() {
      calls.push('discover');
      return {
        providers: [
          {
            id: 'provider',
            driver: 'opencode',
            name: 'Provider',
            available: true,
            models: [{ id: 'selected', name: 'Selected' }],
          },
        ],
      };
    },
    async prepare(command) {
      calls.push('prepare');
      commands.push(structuredClone(command));
      return { method: 'prompt', payload: { messageID: 'stable', commandId: command.commandId } };
    },
    async deliver(command) {
      calls.push('deliver');
      deliveries.push(structuredClone(command));
    },
    async reconcile(command) {
      calls.push('reconcile');
      reconciliations.push(structuredClone(command));
      return false;
    },
    getSessionUrl() {
      calls.push('url');
      return 'https://runtime.example/session';
    },
    close() {},
  };
  return {
    core,
    runtime,
    calls,
    commands,
    deliveries,
    reconciliations,
    initializer: new TaskInitializer(core, runtime, 'https://runtime.example'),
  };
}

test('concurrent starts share one launch and later starts perform no runtime reads', async () => {
  const f = fixture();
  const first = f.initializer.start('task');
  const second = f.initializer.start('task');
  assert.equal(first, second);
  const [task, repeated] = await Promise.all([first, second]);
  assert.equal(task.setup.status, 'submitted');
  assert.deepEqual(repeated, task);
  assert.equal(task.runtimeUrl, 'https://runtime.example/session');
  assert.equal(task.report, null);
  assert.equal(f.commands[0]!.threadId, f.core.record('task').threadId);
  assert.equal(f.commands[0]!.taskId, 'task');
  assert.equal(f.commands[0]!.commandId, `${f.core.record('task').threadId}:start`);
  assert.deepEqual(f.commands[0]!.task.modelSelection, {
    instanceId: 'provider',
    model: 'selected',
  });
  assert.match(f.commands[0]!.message, /task_start/);
  const calls = [...f.calls];
  await f.initializer.start('task');
  f.core.get('task');
  f.core.list();
  assert.deepEqual(f.calls, calls);
});

test('unknown prompt outcome retries only read-only reconciliation with the original command', async () => {
  const f = fixture();
  let confirmed = false;
  f.runtime.deliver = async (command) => {
    f.calls.push('deliver');
    f.deliveries.push(structuredClone(command));
    throw new RuntimeCommandError('private upstream body', 'unknown');
  };
  f.runtime.reconcile = async (command) => {
    f.calls.push('reconcile');
    f.reconciliations.push(structuredClone(command));
    return confirmed;
  };
  const task = await f.initializer.start('task');
  assert.equal(task.setup.status, 'unknown');
  assert.equal(task.setup.error?.code, 'DELIVERY_UNKNOWN');
  assert.ok(!JSON.stringify(task).includes('private upstream body'));
  await Promise.all([f.initializer.start('task'), f.initializer.start('task')]);
  assert.equal(f.reconciliations.length, 1);
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.commands.length, 1);
  assert.deepEqual(f.reconciliations[0], f.deliveries[0]);
  confirmed = true;
  assert.equal((await f.initializer.start('task')).setup.status, 'submitted');
  const calls = [...f.calls];
  await f.initializer.start('task');
  assert.deepEqual(f.calls, calls);
});

test('failed reconciliation preserves uncertainty and never redelivers', async () => {
  const f = fixture();
  f.runtime.deliver = async () => {
    throw new Error('socket closed');
  };
  f.runtime.reconcile = async () => {
    throw new Error('read unavailable');
  };
  assert.equal((await f.initializer.start('task')).setup.status, 'unknown');
  assert.equal((await f.initializer.start('task')).setup.status, 'unknown');
  assert.equal(f.commands.length, 1);
});

test('ambiguous session preparation never launches a second session on retry', async () => {
  const f = fixture();
  let attempts = 0;
  f.runtime.prepare = async () => {
    attempts++;
    throw new RuntimeCommandError('session result unknown', 'unknown');
  };
  const task = await f.initializer.start('task');
  assert.equal(task.setup.status, 'unknown');
  assert.match(task.setup.error!.message, /setup outcome could not be confirmed/);
  assert.match(task.setup.error!.message, /prompt delivery was not attempted/);
  await f.initializer.start('task');
  assert.equal(attempts, 1);
  assert.deepEqual(f.deliveries, []);
  assert.deepEqual(f.reconciliations, []);
});

test('reusing an external task ID in another server instance uses a fresh command identity', async () => {
  const first = fixture();
  const restarted = fixture();
  await first.initializer.start('task');
  await restarted.initializer.start('task');
  assert.notEqual(first.commands[0]!.commandId, restarted.commands[0]!.commandId);
});

test('failed discovery reads fail setup before any runtime mutation', async () => {
  const f = fixture();
  f.runtime.discover = async () => {
    throw new RuntimeCommandError('private discovery response', 'unknown');
  };
  const task = await f.initializer.start('task');
  assert.equal(task.setup.status, 'failed');
  assert.equal(task.setup.error!.code, 'SETUP_FAILED');
  assert.match(task.setup.error!.message, /model discovery failed/);
  assert.match(task.setup.error!.message, /No task session or prompt was created/);
  assert.match(task.setup.error!.message, /submit a new task/);
  assert.deepEqual(f.commands, []);
  assert.deepEqual(f.deliveries, []);
  assert.ok(!JSON.stringify(task).includes('private discovery response'));
});

test('unavailable selected model fails setup without substitution or launch', async () => {
  const f = fixture();
  f.runtime.discover = async () => ({
    providers: [
      {
        id: 'provider',
        driver: 'opencode',
        name: 'Provider',
        available: true,
        models: [{ id: 'other', name: 'Other' }],
      },
    ],
  });
  const task = await f.initializer.start('task');
  assert.equal(task.setup.status, 'failed');
  assert.equal(task.setup.error?.code, 'SETUP_FAILED');
  assert.match(task.setup.error!.message, /selected model is unavailable/);
  assert.deepEqual(f.commands, []);
  await f.initializer.start('task');
  assert.deepEqual(f.commands, []);
});

test('rejected launch is a sanitized setup failure', async () => {
  const f = fixture();
  f.runtime.deliver = async () => {
    throw new RuntimeCommandError('private rejection', 'rejected');
  };
  const task = await f.initializer.start('task');
  assert.equal(task.setup.status, 'failed');
  assert.ok(!JSON.stringify(task).includes('private rejection'));
  await f.initializer.start('task');
  assert.deepEqual(f.reconciliations, []);
});

test('reports arriving during launch remain independent of setup completion', async () => {
  const f = fixture();
  f.runtime.deliver = async () => {
    f.core.reportStatus('task', 'finished', {
      status: 'done',
      summary: 'Agent finished',
    });
  };
  const task = await f.initializer.start('task');
  assert.equal(task.setup.status, 'submitted');
  assert.equal(task.report?.status, 'done');
  assert.equal(task.report?.summary, 'Agent finished');
});
