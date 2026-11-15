import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import { applications } from './app.ts';
import { Core } from './core.ts';
import { SawdError, type Task } from './domain.ts';
import { openApiDocument } from './openapi.ts';
import type { OpenCodeConnection } from './shared/types.ts';

const submission = {
  title: 'Implement task',
  input: { instructions: 'Implement the task.' },
  acceptanceCriteria: ['Works'],
  labels: [],
  executor: 'agent',
};

async function fixture(
  t: TestContext,
  apiToken?: string,
  startTask?: (id: string) => Promise<Task>,
  opencodeConnection?: OpenCodeConnection,
) {
  const core = new Core([
    {
      id: 'agent',
      name: 'Agent',
      description: 'Test',
      capabilities: ['git'],
      provider: 'opencode',
      instanceId: 'instance',
      model: 'model',
      workspaceRoot: '/tmp/sawd',
    },
  ]);
  let ready = true;
  const server = applications(
    core,
    () => ready,
    apiToken,
    undefined,
    startTask ?? (async (id) => core.start(id)),
    opencodeConnection,
  ).app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = (path: string, method = 'GET', body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(apiToken ? { authorization: `Bearer ${apiToken}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return {
    core,
    base,
    request,
    setReady: (value: boolean) => {
      ready = value;
    },
  };
}

test('REST discovery and idempotent acceptance publish only public task data', async (t) => {
  const { core, request } = await fixture(t);
  const agents = await (await request('/v1/agents')).json();
  assert.deepEqual(agents, {
    schemaVersion: 1,
    agents: [{ id: 'agent', name: 'Agent', description: 'Test', capabilities: ['git'] }],
  });
  const accepted = await request('/v1/tasks/task', 'PUT', submission);
  assert.equal(accepted.status, 201);
  const task = await accepted.json();
  assert.equal(task.id, 'task');
  assert.equal(task.title, submission.title);
  assert.deepEqual(task.setup, { status: 'pending' });
  assert.equal(task.report, null);
  assert.deepEqual(task.input, submission.input);
  for (const key of [
    'initialInstructions',
    'followUps',
    'interactions',
    'inputRequests',
    'autonomy',
    'initiator',
  ])
    assert.equal(key in task, false);
  const retry = await request('/v1/tasks/task', 'PUT', submission);
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), task);
  assert.equal(
    (
      await request('/v1/tasks/task', 'PUT', {
        ...submission,
        input: { instructions: 'Different' },
      })
    ).status,
    409,
  );
  assert.deepEqual(await (await request('/v1/tasks')).json(), { tasks: core.list() });
  assert.deepEqual(await (await request('/v1/tasks/task')).json(), task);
  assert.equal('workspacePath' in task, false);
  assert.equal('threadId' in task, false);
  assert.equal((await request('/v1/tasks/missing')).status, 404);
});

test('runtime URL is available in authorized task detail after session creation', async (t) => {
  const { core, base, request } = await fixture(t, 'test-secret');
  await request('/v1/tasks/task', 'PUT', submission);
  assert.equal((await fetch(`${base}/v1/tasks/task`)).status, 401);
  const pending = await request('/v1/tasks/task');
  assert.equal(pending.headers.get('cache-control'), 'no-store');
  assert.equal((await pending.json()).runtimeUrl, null);
  const url = 'https://runtime.example/workspace/session/ses_test';
  core.setSetup('task', { status: 'submitted' }, url);
  assert.equal((await (await request('/v1/tasks/task')).json()).runtimeUrl, url);
  await request('/v1/tasks/other', 'PUT', submission);
  assert.equal((await (await request('/v1/tasks/other')).json()).runtimeUrl, null);
  assert.equal((await request('/v1/tasks/task/runtime-link')).status, 404);
});

test('REST submissions reject missing or invalid titles before accepting a task', async (t) => {
  const { request } = await fixture(t);
  const { title, ...untitled } = submission;
  for (const payload of [
    untitled,
    ...['', '   ', 'x'.repeat(201), null, 42].map((title) => ({ ...submission, title })),
  ]) {
    const response = await request('/v1/tasks/task', 'PUT', payload);
    assert.equal(response.status, 400);
    assert.match((await response.json()).error.message, /^title:/);
  }
  assert.deepEqual(await (await request('/v1/tasks')).json(), { tasks: [] });
  const accepted = await request('/v1/tasks/task', 'PUT', { ...submission, title: `  ${title}  ` });
  assert.equal(accepted.status, 201);
  assert.equal((await accepted.json()).title, title);
  assert.equal((await request('/v1/tasks/task', 'PUT', submission)).status, 200);
  assert.equal(
    (await request('/v1/tasks/task', 'PUT', { ...submission, title: 'Changed title' })).status,
    409,
  );
});

test('OpenCode login details require API access and are never cached or included in tasks', async (t) => {
  const connection = { url: 'https://runtime.example/opencode', password: 'test-runtime-secret' };
  const { base, request } = await fixture(t, 'test-api-secret', undefined, connection);
  for (const authorization of ['', 'Bearer wrong']) {
    const denied = await fetch(`${base}/v1/opencode/connection`, { headers: { authorization } });
    assert.equal(denied.status, 401);
    assert.equal((await denied.text()).includes(connection.password), false);
  }
  const response = await request('/v1/opencode/connection');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.deepEqual(await response.json(), connection);
  await request('/v1/tasks/task', 'PUT', submission);
  for (const path of ['/v1/tasks', '/v1/tasks/task', '/v1/agents', '/v1/openapi.json'])
    assert.equal((await (await request(path)).text()).includes(connection.password), false);
  const local = await fixture(t, undefined, undefined, connection);
  assert.deepEqual(await (await local.request('/v1/opencode/connection')).json(), connection);
  const unavailable = await fixture(t);
  const missing = await unavailable.request('/v1/opencode/connection');
  assert.equal(missing.status, 503);
  assert.equal(missing.headers.get('cache-control'), 'no-store');
  assert.equal((await missing.json()).error.code, 'NOT_READY');
});

test('REST submissions reject removed autonomy and initiator fields independently', async (t) => {
  const { request } = await fixture(t);
  for (const legacyField of ['autonomy', 'initiator', 'deadlineAt'] as const) {
    const response = await request('/v1/tasks/task', 'PUT', {
      ...submission,
      [legacyField]: legacyField === 'autonomy' ? 'guided' : 'tester',
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'VALIDATION_FAILED');
  }
});

test('REST starts setup and archives without an execution lifecycle', async (t) => {
  const { core, request } = await fixture(t);
  await request('/v1/tasks/task', 'PUT', submission);
  const archived = await (await request('/v1/tasks/task/archive', 'POST')).json();
  assert.equal(archived.setup.status, 'pending');
  assert.ok(archived.archivedAt);
  assert.deepEqual(await (await request('/v1/tasks/task/archive', 'POST')).json(), archived);
  const started = await (await request('/v1/tasks/task/start', 'POST')).json();
  assert.equal(started.setup.status, 'starting');
  assert.equal(started.report, null);
  assert.equal(started.archivedAt, archived.archivedAt);
  assert.deepEqual(await (await request('/v1/tasks/task/start', 'POST')).json(), started);
  core.reportStatus('task', 'done', { status: 'done', summary: 'Finished' });
  const detail = await (await request('/v1/tasks/task')).json();
  assert.equal(detail.report.status, 'done');
  assert.equal(detail.setup.status, 'starting');
});

test('REST start propagates asynchronous initializer results and sanitizes exceptions', async (t) => {
  const { core, request } = await fixture(t, undefined, async (id) => {
    await Promise.resolve();
    core.start(id);
    return core.setSetup(id, {
      status: 'unknown',
      error: { code: 'DELIVERY_UNKNOWN', message: 'Inspect OpenCode.' },
    });
  });
  core.accept('task', submission);
  const response = await request('/v1/tasks/task/start', 'POST');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).setup.status, 'unknown');
  const broken = await fixture(t, undefined, async () => {
    throw new Error('private-runtime-detail');
  });
  broken.core.accept('task', submission);
  const failure = await broken.request('/v1/tasks/task/start', 'POST');
  assert.equal(failure.status, 500);
  assert.deepEqual(await failure.json(), {
    error: { code: 'INTERNAL_ERROR', message: 'Unable to process this request.' },
  });
});

test('REST exposes its versioned schema and leaves unversioned business routes unavailable', async (t) => {
  const { request } = await fixture(t);
  assert.deepEqual(await (await request('/v1/openapi.json')).json(), openApiDocument);
  for (const [path, method] of [
    ['/tasks', 'GET'],
    ['/tasks/task', 'PUT'],
    ['/tasks/task/start', 'POST'],
    ['/agents', 'GET'],
    ['/t3/pairing', 'POST'],
  ]) {
    const response = await request(path, method);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: { code: 'ROUTE_NOT_FOUND', message: 'Route not found.' },
    });
  }
  const unknown = await request('/v2/tasks');
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error.code, 'ROUTE_NOT_FOUND');
});

test('readiness gates mutations while health and discovery remain readable', async (t) => {
  const { request, setReady } = await fixture(t);
  await request('/v1/tasks/task', 'PUT', submission);
  setReady(false);
  assert.equal((await request('/healthz')).status, 200);
  assert.equal((await request('/readyz')).status, 503);
  assert.equal((await request('/v1/agents')).status, 200);
  assert.equal((await request('/v1/tasks/task')).status, 200);
  for (const [path, method, body] of [
    ['/v1/tasks/new', 'PUT', submission],
    ['/v1/tasks/task/start', 'POST', undefined],
    ['/v1/tasks/task/archive', 'POST', undefined],
  ] as const) {
    const response = await request(path, method, body);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: { code: 'NOT_READY', message: 'SAWD is not ready.' },
    });
  }
});

test('invalid payloads and internal exceptions return sanitized JSON errors', async (t) => {
  const { core, base, request } = await fixture(t);
  const malformed = await fetch(`${base}/v1/tasks/task`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: '{"private":"do-not-echo",broken',
  });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), {
    error: { code: 'VALIDATION_FAILED', message: 'Invalid JSON request body.' },
  });
  assert.equal(
    (await request('/v1/tasks/task', 'PUT', { ...submission, taskId: 'task' })).status,
    400,
  );
  const oversized = await request('/v1/tasks/task', 'PUT', {
    ...submission,
    input: { instructions: 'x'.repeat(1024 * 1024) },
  });
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).error.code, 'PAYLOAD_TOO_LARGE');
  core.accept = () => {
    throw new SawdError('Specific validation failure.', 400, 'CUSTOM_VALIDATION', {
      field: 'title',
    });
  };
  const validation = await request('/v1/tasks/task', 'PUT', submission);
  assert.equal(validation.status, 400);
  assert.deepEqual(await validation.json(), {
    error: {
      code: 'CUSTOM_VALIDATION',
      message: 'Specific validation failure.',
      details: { field: 'title' },
    },
  });
  core.accept = () => {
    throw new Error('private-internal-detail');
  };
  const failed = await request('/v1/tasks/task', 'PUT', submission);
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), {
    error: { code: 'INTERNAL_ERROR', message: 'Unable to process this request.' },
  });
});

test('configured bearer authorization protects REST without exposing CORS', async (t) => {
  const { base, request } = await fixture(t, 'test-secret');
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/v1/agents`)).status, 401);
  const unauthorized = await fetch(`${base}/v1/tasks`);
  assert.deepEqual(await unauthorized.json(), {
    error: { code: 'UNAUTHORIZED', message: 'A valid bearer token is required.' },
  });
  const response = await request('/v1/agents');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal(response.headers.get('x-powered-by'), null);
});

test('removed runtime control and interaction routes return not found without mutating tasks', async (t) => {
  const { core, request } = await fixture(t);
  core.accept('task', submission);
  const before = structuredClone(core.record('task'));
  for (const path of ['/v1/tasks/task/follow-ups', '/v1/t3/pairing', '/v1/tasks/task/cancel']) {
    const response = await request(path, 'POST', { instructions: 'Continue' });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: { code: 'ROUTE_NOT_FOUND', message: 'Route not found.' },
    });
  }
  assert.deepEqual(core.record('task'), before);
});
