import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { applications } from './app.ts';
import { Core } from './core.ts';
import { SawdError } from './domain.ts';
import { reportingInstructionsReference, reportingServerName } from './reporting-instructions.ts';

async function fixture(t: TestContext) {
  const core = new Core([
    {
      id: 'agent',
      name: 'Agent',
      description: 'Test',
      capabilities: [],
      provider: 'opencode',
      instanceId: 'instance',
      model: 'model',
      workspaceRoot: '/tmp/sawd',
    },
  ]);
  core.accept('task', {
    title: 'MCP task',
    input: { instructions: 'Implement the task.' },
    executor: 'agent',
  });
  core.start('task');
  let ready = true;
  const apps = applications(core, () => ready);
  const server = apps.mcp.listen(0, '127.0.0.1');
  const http = apps.app.listen(0, '127.0.0.1');
  await Promise.all([once(server, 'listening'), once(http, 'listening')]);
  const mcpUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
  const url = `${mcpUrl}/tasks/task`;
  const base = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const clients: Client[] = [];
  const connect = async (path = '/tasks/task') => {
    const client = new Client({ name: 'sawd-test', version: '1' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${mcpUrl}${path}`)));
    return client;
  };
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close()));
    for (const listener of [server, http]) {
      listener.closeAllConnections();
      listener.close();
    }
  });
  const client = await connect();
  return {
    core,
    client,
    connect,
    mcpUrl,
    url,
    base,
    call: (name: string, args: Record<string, unknown>) =>
      client.callTool({ name, arguments: args }),
    setReady: (value: boolean) => {
      ready = value;
    },
  };
}
function textResult(result: Awaited<ReturnType<Client['callTool']>>) {
  assert.ok(Array.isArray(result.content));
  const first = result.content[0];
  assert.ok(first && first.type === 'text');
  return first.text;
}

test('unbound MCP exposes instructions but cannot write even with a task argument', async (t) => {
  const { core, connect } = await fixture(t);
  const client = await connect('');
  assert.deepEqual(
    (await client.listTools()).tools.map((tool) => tool.name),
    ['get_reporting_instructions'],
  );
  assert.ok(
    !(await client.callTool({ name: 'get_reporting_instructions', arguments: {} })).isError,
  );
  const before = structuredClone(core.record('task'));
  for (const name of ['report_status', 'create_attachment']) {
    const result = await client.callTool({ name, arguments: { taskId: 'task' } });
    assert.equal(result.isError, true);
    assert.deepEqual(core.record('task'), before);
  }
});

test('task URLs isolate concurrent writes and retries across reconnects without prompt context', async (t) => {
  const { core, client, connect } = await fixture(t);
  core.accept('other', {
    title: 'Other task',
    input: { instructions: 'Independent work.' },
    executor: 'agent',
  });
  core.start('other');
  const other = await connect('/tasks/other');
  const requests = ['task', 'other'].map((taskId) => ({
    name: 'report_status',
    arguments: {
      operationId: 'progress',
      report: { status: 'running', summary: `Working on ${taskId}` },
    },
  }));
  const receipts = await Promise.all([client.callTool(requests[0]!), other.callTool(requests[1]!)]);
  for (const [index, taskId] of ['task', 'other'].entries()) {
    assert.ok(!receipts[index]!.isError, textResult(receipts[index]!));
    assert.equal(JSON.parse(textResult(receipts[index]!)).taskId, taskId);
    assert.equal(core.get(taskId).report?.summary, `Working on ${taskId}`);
  }
  const attachments = await Promise.all(
    [client, other].map((connection, index) =>
      connection.callTool({
        name: 'create_attachment',
        arguments: {
          operationId: 'evidence',
          attachment: { kind: 'evidence', title: `Result ${index}`, text: 'Verified' },
        },
      }),
    ),
  );
  for (const [index, taskId] of ['task', 'other'].entries()) {
    assert.ok(!attachments[index]!.isError, textResult(attachments[index]!));
    assert.deepEqual(
      core.get(taskId).attachments.map((item) => item.title),
      [`Result ${index}`],
    );
  }
  await client.close();
  const reconnected = await connect();
  assert.deepEqual(await reconnected.callTool(requests[0]!), receipts[0]);
  const result = await reconnected.callTool({
    name: 'report_status',
    arguments: { operationId: 'resumed', report: { status: 'done', summary: 'Complete' } },
    _meta: { taskId: 'other' },
  });
  assert.ok(!result.isError, textResult(result));
  assert.equal(core.get('task').report?.status, 'done');
  assert.equal(core.get('other').report?.status, 'running');
});

test('invalid, unknown and stale task URLs fail without falling back to another task', async (t) => {
  const { core, client, mcpUrl } = await fixture(t);
  const before = structuredClone(core.record('task'));
  for (const [taskId, status, code] of [
    ['missing', 404, 'TASK_NOT_FOUND'],
    ['bad/id', 400, 'VALIDATION_FAILED'],
    ['x'.repeat(129), 400, 'VALIDATION_FAILED'],
  ] as const) {
    const response = await fetch(`${mcpUrl}/tasks/${encodeURIComponent(taskId)}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(response.status, status);
    assert.equal((await response.json()).error.code, code);
    assert.deepEqual(core.record('task'), before);
  }
  core.records.clear();
  await assert.rejects(
    client.callTool({
      name: 'report_status',
      arguments: { operationId: 'stale', report: { status: 'done', summary: 'Complete' } },
    }),
    /TASK_NOT_FOUND/,
  );
  assert.equal(core.records.size, 0);
});

test('task URL clients discover and use reporting without task arguments or native attribution', async (t) => {
  const { core, client, call, setReady } = await fixture(t);
  assert.equal(client.getServerVersion()?.name, reportingServerName);
  assert.equal(client.getInstructions(), reportingInstructionsReference);
  setReady(false);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
    'create_attachment',
    'get_reporting_instructions',
    'report_status',
  ]);
  const reportSchema = JSON.stringify(
    tools.tools.find((tool) => tool.name === 'report_status')!.inputSchema,
  );
  for (const key of ['executionToken', 'taskId', 'workVersion', 'expectedRevision', '_sawdOrigin'])
    assert.equal(reportSchema.includes(key), false);
  const instructions = await call('get_reporting_instructions', {});
  assert.ok(!instructions.isError);
  assert.doesNotMatch(textResult(instructions), /executionToken/);
  setReady(true);
  const saved = await call('report_status', {
    operationId: 'done',
    report: { status: 'done', summary: 'Finished' },
  });
  assert.ok(!saved.isError, textResult(saved));
  assert.equal(core.get('task').report?.status, 'done');
  const receipt = JSON.parse(textResult(saved));
  assert.deepEqual(receipt, {
    taskId: 'task',
    operationId: 'done',
    receivedAt: core.get('task').report!.receivedAt,
  });
});

test('MCP attachment idempotency and strict inputs remain enforced', async (t) => {
  const { core, call } = await fixture(t);
  const args = {
    operationId: 'decision',
    attachment: {
      kind: 'decision',
      title: 'Approach',
      summary: 'Use A',
      rationale: 'Fits the task',
    },
  };
  const saved = await call('create_attachment', args);
  assert.ok(!saved.isError);
  assert.deepEqual(await call('create_attachment', args), saved);
  const conflict = await call('create_attachment', {
    ...args,
    attachment: { ...args.attachment, title: 'Changed' },
  });
  assert.equal(conflict.isError, true);
  assert.equal(JSON.parse(textResult(conflict)).error.code, 'IDEMPOTENCY_CONFLICT');
  assert.deepEqual(core.get('task').attachments, [JSON.parse(textResult(saved))]);
  const before = structuredClone(core.record('task'));
  for (const extra of [
    { taskId: 'other' },
    { executionToken: '0'.repeat(64) },
    { _sawdOrigin: { sessionId: 'session', callId: 'call' } },
  ]) {
    const rejected = await call('report_status', {
      operationId: 'invalid',
      report: { status: 'done', summary: 'No' },
      ...extra,
    });
    assert.equal(rejected.isError, true);
    assert.deepEqual(core.record('task'), before);
  }
});

test('MCP reports update REST detail atomically while collection responses remain compact', async (t) => {
  const { core, call, base } = await fixture(t);
  const steps = [{ id: 'implement', text: 'Implement the change', status: 'running' }];
  const args = {
    operationId: 'plan',
    report: { status: 'running', summary: 'Implementing', plan: { steps } },
  };
  const saved = await call('report_status', args);
  assert.ok(!saved.isError, textResult(saved));
  assert.deepEqual(await call('report_status', args), saved);
  const detail = await (await fetch(`${base}/v1/tasks/task`)).json();
  assert.deepEqual(detail.plan, { steps });
  assert.equal(detail.report.summary, 'Implementing');
  assert.deepEqual(detail, core.get('task'));
  const list = await (await fetch(`${base}/v1/tasks`)).json();
  assert.deepEqual(list, { tasks: core.list() });
  for (const key of ['input', 'acceptanceCriteria', 'plan', 'attachments'])
    assert.equal(key in list.tasks[0], false);
});

test('new reports continue after outcomes and archival without changing setup or replaying old state', async (t) => {
  const { core, call } = await fixture(t);
  core.setSetup('task', { status: 'submitted' });
  const done = {
    operationId: 'done',
    report: { status: 'done', summary: 'Complete' },
  };
  const original = await call('report_status', done);
  core.archive('task');
  for (const status of ['failed', 'input_required', 'running']) {
    const report = await call('report_status', {
      ...done,
      operationId: status,
      report: { status, summary: 'New information' },
    });
    assert.ok(!report.isError, textResult(report));
    assert.equal(core.get('task').report?.status, status);
    assert.deepEqual(core.get('task').setup, { status: 'submitted' });
  }
  const before = core.get('task');
  assert.deepEqual(await call('report_status', done), original);
  assert.deepEqual(core.get('task'), before);
});

test('MCP rejects invalid plans and control fields without partial changes', async (t) => {
  const { core, call } = await fixture(t);
  const before = structuredClone(core.record('task'));
  for (const report of [
    { status: 'done', summary: 'No', workVersion: 1 },
    { status: 'done', summary: 'No', messageId: 'turn' },
    { status: 'done', summary: 'No', plan: { revision: 0, steps: [] } },
    { status: 'cancelled', summary: 'No' },
    ...[
      [{ id: 'step', text: 'Work', status: 'unknown' }],
      [{ id: '../step', text: 'Work', status: 'running' }],
      [{ id: 'step', text: ' ', status: 'running' }],
      [
        { id: 'step', text: 'First', status: 'running' },
        { id: 'step', text: 'Duplicate', status: 'pending' },
      ],
    ].map((steps) => ({ status: 'done', summary: 'No', plan: { steps } })),
  ]) {
    const result = await call('report_status', {
      operationId: 'invalid',
      report,
    });
    assert.equal(result.isError, true);
    assert.deepEqual(core.record('task'), before);
  }
});

test('MCP readiness gates writes while instructions stay available and non-POST methods fail', async (t) => {
  const { core, call, url, setReady } = await fixture(t);
  setReady(false);
  for (const [name, payload] of [
    ['create_attachment', { attachment: { kind: 'evidence', title: 'Result', text: 'Verified' } }],
    ['report_status', { report: { status: 'running', summary: 'Progress' } }],
  ] as const) {
    const result = await call(name, { operationId: 'write', ...payload });
    assert.equal(result.isError, true);
    assert.deepEqual(JSON.parse(textResult(result)), {
      error: { code: 'NOT_READY', message: 'SAWD is not ready.' },
    });
  }
  assert.equal(core.record('task').operations.size, 0);
  assert.ok(!(await call('get_reporting_instructions', {})).isError);
  for (const method of ['GET', 'DELETE']) {
    const response = await fetch(url, {
      method,
      headers: { accept: 'application/json, text/event-stream' },
    });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'POST');
  }
});

test('MCP domain errors preserve details and internal failures remain sanitized', async (t) => {
  const { core, call } = await fixture(t);
  const report = t.mock.method(core, 'reportStatus', () => {
    throw new SawdError('Reporting is unavailable.', 409, 'TASK_STATE_CONFLICT', {
      setupStatus: 'pending',
    });
  });
  const args = {
    operationId: 'report',
    report: { status: 'running', summary: 'Progress' },
  };
  const conflict = await call('report_status', args);
  assert.equal(conflict.isError, true);
  assert.deepEqual(JSON.parse(textResult(conflict)), {
    error: {
      code: 'TASK_STATE_CONFLICT',
      message: 'Reporting is unavailable.',
      details: { setupStatus: 'pending' },
    },
  });
  report.mock.mockImplementation(() => {
    throw new Error('private-internal-detail');
  });
  const failed = await call('report_status', args);
  assert.equal(failed.isError, true);
  assert.deepEqual(JSON.parse(textResult(failed)), {
    error: { code: 'INTERNAL_ERROR', message: 'Unable to process this tool call.' },
  });
});
