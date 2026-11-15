import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { start } from './bootstrap.ts';
import { configuration } from './config.ts';
import { OpenCodeClient } from './opencode/client.ts';

async function ports() {
  const servers = [createServer(), createServer()];
  for (const server of servers) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
  }
  const values = servers.map((server) => (server.address() as { port: number }).port);
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  return values as [number, number];
}
const discovery = {
  taskWorkspaceRoot: '/tmp/sawd',
  providers: [
    {
      id: 'gateway',
      driver: 'opencode',
      name: 'Gateway',
      available: true,
      models: [{ id: 'model', name: 'Model' }],
    },
  ],
};

test('bootstrap probes reporting instructions, wires initial launch, and closes listeners and runtime once', async (t) => {
  const [port, mcpPort] = await ports();
  const discover = t.mock.method(OpenCodeClient.prototype, 'discover', async () =>
    structuredClone(discovery),
  );
  const register = t.mock.method(OpenCodeClient.prototype, 'registerReporting', async () => {});
  const closeRuntime = t.mock.method(OpenCodeClient.prototype, 'close', () => {});
  const prepare = t.mock.method(OpenCodeClient.prototype, 'prepare', async () => ({
    method: 'prompt',
    payload: {},
  }));
  const deliver = t.mock.method(OpenCodeClient.prototype, 'deliver', async () => {});
  const sessionUrl = t.mock.method(
    OpenCodeClient.prototype,
    'getSessionUrl',
    () => 'https://runtime.example/session',
  );
  const signalListeners = process.listenerCount('SIGTERM');
  const close = await start({
    ...configuration({
      OPENCODE_PUBLIC_URL: 'https://runtime.example',
      OPENCODE_PASSWORD: 'test-password',
    }),
    port,
    mcpPort,
  });
  t.after(close);
  assert.deepEqual(register.mock.calls[0]!.arguments, [`http://127.0.0.1:${mcpPort}/mcp`]);
  assert.equal((await fetch(`http://127.0.0.1:${port}/readyz`)).status, 200);
  const agents = await (await fetch(`http://127.0.0.1:${port}/v1/agents`)).json();
  assert.deepEqual(agents.agents[0].capabilities, ['git', 'node', 'python']);
  const accepted = await fetch(`http://127.0.0.1:${port}/v1/tasks/link`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'Runtime link',
      input: { instructions: 'Test navigation' },
      acceptanceCriteria: [],
      labels: [],
      executor: agents.agents[0].id,
    }),
  });
  assert.equal(accepted.status, 201);
  const endpoint = `http://127.0.0.1:${port}/v1/tasks/link`;
  const launched = await (await fetch(`${endpoint}/start`, { method: 'POST' })).json();
  assert.equal(launched.setup.status, 'submitted');
  assert.equal(launched.runtimeUrl, 'https://runtime.example/session');
  assert.equal(sessionUrl.mock.calls[0]!.arguments[1], 'https://runtime.example');
  const connection = await fetch(`http://127.0.0.1:${port}/v1/opencode/connection`);
  assert.deepEqual(await connection.json(), {
    url: 'https://runtime.example',
    password: 'test-password',
  });
  for (let retry = 0; retry < 2; retry++) {
    await fetch(`${endpoint}/start`, { method: 'POST' });
    await fetch(endpoint);
    await fetch(`http://127.0.0.1:${port}/v1/tasks`);
  }
  assert.equal(discover.mock.callCount(), 2);
  assert.equal(prepare.mock.callCount(), 1);
  assert.equal(prepare.mock.calls[0]!.arguments[0]!.taskId, 'link');
  assert.equal(deliver.mock.callCount(), 1);
  process.emit('SIGTERM');
  await close();
  await close();
  assert.equal(closeRuntime.mock.callCount(), 1);
  assert.equal(process.listenerCount('SIGTERM'), signalListeners);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/healthz`));
  await assert.rejects(fetch(`http://127.0.0.1:${mcpPort}/mcp`));
});

test('reporting registration failure closes listeners and sanitizes runtime errors', async (t) => {
  const [port, mcpPort] = await ports();
  t.mock.method(OpenCodeClient.prototype, 'discover', async () => structuredClone(discovery));
  t.mock.method(OpenCodeClient.prototype, 'registerReporting', async () => {
    throw new Error('private-runtime-response');
  });
  const closeRuntime = t.mock.method(OpenCodeClient.prototype, 'close', () => {});
  const signalListeners = process.listenerCount('SIGINT');
  await assert.rejects(
    start({ ...configuration({ OPENCODE_PASSWORD: 'test-password' }), port, mcpPort }),
    {
      message: 'SAWD startup failed while registering reporting tools with opencode.',
    },
  );
  assert.equal(closeRuntime.mock.callCount(), 1);
  assert.equal(process.listenerCount('SIGINT'), signalListeners);
  await assert.rejects(fetch(`http://127.0.0.1:${mcpPort}/mcp`));
});

test('bootstrap rejects discovery without an executable model before opening listeners', async (t) => {
  t.mock.method(OpenCodeClient.prototype, 'discover', async () => ({
    ...discovery,
    providers: [],
  }));
  const register = t.mock.method(OpenCodeClient.prototype, 'registerReporting', async () => {});
  await assert.rejects(start(configuration({ OPENCODE_PASSWORD: 'test-password' })), {
    message: 'opencode has no available models supporting tool execution.',
  });
  assert.equal(register.mock.callCount(), 0);
});

test('shutdown during discovery closes the runtime without starting listeners', async (t) => {
  let resolveDiscovery!: (value: typeof discovery) => void;
  t.mock.method(
    OpenCodeClient.prototype,
    'discover',
    () =>
      new Promise((resolve) => {
        resolveDiscovery = resolve;
      }),
  );
  const closeRuntime = t.mock.method(OpenCodeClient.prototype, 'close', () => {});
  const before = process.listenerCount('SIGTERM');
  const running = start(configuration({ OPENCODE_PASSWORD: 'test-password' }));
  process.emit('SIGTERM');
  resolveDiscovery(discovery);
  const close = await running;
  await close();
  assert.equal(closeRuntime.mock.callCount(), 1);
  assert.equal(process.listenerCount('SIGTERM'), before);
});
