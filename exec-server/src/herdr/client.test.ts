import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { eventually } from '../testing.ts';
import { HerdrClient, HerdrError } from './client.ts';
import { launchScript, quote } from './command.ts';

/** A stand-in Herdr: answers each JSON line with whatever `reply` returns. */
async function fakeHerdr(
  t: TestContext,
  reply: (request: { id: string; method: string; params: unknown }, socket: net.Socket) => unknown,
) {
  const path = join(mkdtempSync(join(tmpdir(), 'herdr-')), 'herdr.sock');
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
        const request = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        const response = reply(request, socket);
        if (response !== undefined) socket.write(`${JSON.stringify(response)}\n`);
      }
    });
    socket.on('error', () => {});
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  return { path, sockets };
}

test('call sends one JSON line and returns the result', async (t) => {
  const seen: unknown[] = [];
  const { path } = await fakeHerdr(t, (request) => {
    seen.push({ method: request.method, params: request.params });
    return { id: request.id, result: { type: 'pong', version: '0.9.5' } };
  });
  const client = new HerdrClient(path);
  assert.deepEqual(await client.call('ping'), { type: 'pong', version: '0.9.5' });
  await client.call('pane.get', { pane_id: 'w1:p1' });
  assert.deepEqual(seen, [
    { method: 'ping', params: {} },
    { method: 'pane.get', params: { pane_id: 'w1:p1' } },
  ]);
});

test('Herdr errors, a missing socket and silence all reject with a code', async (t) => {
  const { path } = await fakeHerdr(t, (request) =>
    request.method === 'slow'
      ? undefined
      : { id: request.id, error: { code: 'pane_not_found', message: 'no such pane' } },
  );
  await assert.rejects(
    new HerdrClient(path).call('pane.get', { pane_id: 'x' }),
    (error: HerdrError) => {
      assert.equal(error.code, 'pane_not_found');
      assert.match(error.message, /pane\.get: no such pane/);
      return true;
    },
  );
  await assert.rejects(
    new HerdrClient(join(tmpdir(), 'no-such-herdr.sock')).call('ping'),
    (error: HerdrError) => error.code === 'unreachable',
  );
  await assert.rejects(
    new HerdrClient(path, 50).call('slow'),
    (error: HerdrError) => error.code === 'timeout',
  );
});

test('subscribe streams events and reconnects after the connection drops', async (t) => {
  let connections = 0;
  const { path, sockets } = await fakeHerdr(t, (request, socket) => {
    connections += 1;
    setTimeout(
      () =>
        socket.write(
          `${JSON.stringify({ event: 'pane_exited', data: { pane_id: `p${connections}` } })}\n`,
        ),
      5,
    );
    return { id: request.id, result: { type: 'subscription_started' } };
  });
  const events: string[] = [];
  let gaps = 0;
  const stop = new HerdrClient(path).subscribe(
    [{ type: 'pane.exited' }],
    (event) => events.push(`${event.event}:${event.data.pane_id}`),
    () => (gaps += 1),
  );
  t.after(stop);
  await eventually(() => assert.deepEqual(events, ['pane_exited:p1']));
  for (const socket of sockets) socket.destroy();
  await eventually(() => assert.deepEqual(events, ['pane_exited:p1', 'pane_exited:p2']), 5000);
  assert.equal(gaps, 1, 'the caller is told events may have been missed');
});

const launch = {
  runId: '1234abcd-0000-4000-8000-000000000000',
  stage: 'implement' as const,
  attempt: 2,
  worktreePath: "/home/factory/worktrees/it's here",
  repositoryPath: '/home/factory/repos/acme/widgets',
  runDirectory: '/home/factory/runs-data/1234',
  promptFile: '/home/factory/runs-data/1234/stages/implement-2.prompt.md',
  mcpUrl: 'http://host.docker.internal:3776/mcp/runs/1234/stages/implement',
  image: 'localhost/factory-agent:latest',
  envFile: '/home/factory/agent.env',
};

test('the launch script runs the agent container with host-path mounts and no inline secrets', () => {
  const script = launchScript(launch);
  assert.match(script, /^#!\/usr\/bin\/env bash\nset -euo pipefail\n/);
  assert.match(script, /exec docker run --rm -it/);
  assert.match(script, /--name 'factory-1234abcd-implement-2'/);
  assert.doesNotMatch(script, /--add-host/);
  assert.match(
    launchScript({ ...launch, dockerArgs: '--add-host=a:b' }),
    /\n  --add-host=a:b \\\n/,
  );
  assert.match(script, /--env-file '\/home\/factory\/agent\.env'/);
  assert.match(
    script,
    /-e 'FACTORY_MCP_URL=http:\/\/host\.docker\.internal:3776\/mcp\/runs\/1234\/stages\/implement'/,
  );
  assert.ok(
    script.includes(`-v '/home/factory/repos/acme/widgets:/home/factory/repos/acme/widgets'`),
  );
  assert.ok(
    script.includes(`-w '/home/factory/worktrees/it'\\''s here'`),
    'paths are shell-quoted',
  );
  assert.doesNotMatch(script, /TOKEN|API_KEY/);
  assert.equal(quote("a'b"), `'a'\\''b'`);
});

test('an agent command override runs on the host with the same stage environment', () => {
  const script = launchScript({
    ...launch,
    agentCommand: 'node /tmp/stub.mjs',
    model: 'test-model',
  });
  assert.doesNotMatch(script, /docker run/);
  assert.match(script, /export FACTORY_STAGE='implement'\n/);
  assert.match(script, /export FACTORY_AGENT_MODEL='test-model'\n/);
  assert.match(script, /\nexec node \/tmp\/stub\.mjs\n$/);
});
