import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { WebSocket } from 'ws';
import { TerminalService, loopbackHost } from './terminal.ts';

async function serve(t: TestContext) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'terminal-test-')));
  const service = new TerminalService({ shell: '/bin/sh', home, worktree: () => undefined });
  const server = createServer();
  service.attach(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    service.close();
    server.closeAllConnections();
    server.close();
  });
  const port = (server.address() as { port: number }).port;
  return {
    service,
    home,
    url: (ticket: string) => `ws://127.0.0.1:${port}/v1/terminal?ticket=${ticket}`,
  };
}

test('a ticket opens a shell in the working directory and runs commands', async (t) => {
  const { service, home, url } = await serve(t);
  const ws = new WebSocket(url(service.issueTicket().ticket));
  await once(ws, 'open');
  let output = '';
  ws.on('message', (data: Buffer) => (output += data.toString()));
  ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
  ws.send(Buffer.from('pwd; stty size; echo done-$((20+22))\n'));
  for (let i = 0; i < 100 && !output.includes('done-42'); i++)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(output.includes(home), output);
  assert.ok(output.includes('30 100'), output);
  assert.ok(output.includes('done-42'), output);
  ws.send(Buffer.from('exit\n'));
  const [code] = await once(ws, 'close');
  assert.equal(code, 1000);
});

test('tickets are single use and unknown tickets are refused', async (t) => {
  const { service, url } = await serve(t);
  const { ticket } = service.issueTicket();
  const first = new WebSocket(url(ticket));
  await once(first, 'open');
  first.close();
  const second = new WebSocket(url(ticket));
  const [error] = await once(second, 'error');
  assert.match((error as Error).message, /401/);
  const forged = new WebSocket(url('nope'));
  assert.match(((await once(forged, 'error'))[0] as Error).message, /401/);
});

test('connections from other origins or hosts are refused', async (t) => {
  const { service, url } = await serve(t);
  const foreign = new WebSocket(url(service.issueTicket().ticket), {
    headers: { origin: 'https://evil.example' },
  });
  assert.match(((await once(foreign, 'error'))[0] as Error).message, /403/);
  assert.equal(loopbackHost('127.0.0.1:3785'), true);
  assert.equal(loopbackHost('localhost'), true);
  assert.equal(loopbackHost('[::1]:80'), true);
  assert.equal(loopbackHost('evil.example:3785'), false);
  assert.equal(loopbackHost('http://localhost:5174', true), true);
  assert.equal(loopbackHost('http://localhost.evil.example', true), false);
});
