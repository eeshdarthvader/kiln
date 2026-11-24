#!/usr/bin/env node
// Herdr compatibility check for the factory. Talks to a named Herdr session over its
// Unix socket and exercises every call the factory relies on, printing the raw results.
// Usage: herdr --session factory server &   then   node scripts/herdr-spike.mjs [session]
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const session = process.argv[2] ?? 'factory';
const socketPath =
  process.env.HERDR_SOCKET_PATH ??
  path.join(os.homedir(), '.config/herdr/sessions', session, 'herdr.sock');
const dockerImage = process.env.SPIKE_IMAGE ?? 'alpine:3';

let counter = 0;

/** One request per connection: write a JSON line, read one JSON line back. */
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const id = `spike_${++counter}`;
    let buffer = '';
    socket.setTimeout(20_000, () => socket.destroy(new Error(`${method} timed out`)));
    socket.on('connect', () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      socket.end();
      const message = JSON.parse(buffer.slice(0, newline));
      if (message.error) reject(new Error(`${method}: ${JSON.stringify(message.error)}`));
      else resolve(message.result);
    });
    socket.on('error', reject);
  });
}

/** A long-lived subscription; every line after the acknowledgement is an event. */
function subscribe(subscriptions, onEvent) {
  const socket = net.createConnection(socketPath);
  let buffer = '';
  socket.on('connect', () =>
    socket.write(
      `${JSON.stringify({ id: 'spike_sub', method: 'events.subscribe', params: { subscriptions } })}\n`,
    ),
  );
  socket.on('data', (chunk) => {
    buffer += chunk;
    for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
      onEvent(JSON.parse(buffer.slice(0, newline)));
      buffer = buffer.slice(newline + 1);
    }
  });
  socket.on('error', (error) => console.error('subscription error', error.message));
  return () => socket.destroy();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const show = (label, value) => console.log(`\n## ${label}\n${JSON.stringify(value, null, 2)}`);

const scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'herdr-spike-')));
const repo = path.join(scratch, 'repo');
execFileSync('git', ['init', '-q', '-b', 'main', repo]);
execFileSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init']);

show('ping', await call('ping'));

const events = [];
const unsubscribe = subscribe(
  [{ type: 'pane.exited' }, { type: 'pane.closed' }, { type: 'pane.agent_detected' }],
  (event) => events.push(event),
);

const worktree = await call('worktree.create', {
  cwd: repo,
  branch: 'factory/spike',
  base: 'main',
  path: path.join(scratch, 'worktree'),
  label: 'spike',
  focus: false,
  trust_repository: true,
});
show('worktree.create', worktree);

const workspaceId = worktree.workspace?.workspace_id ?? worktree.workspace_id;
const panes = await call('pane.list', { workspace_id: workspaceId });
show('pane.list', panes);
const firstPane = panes.panes[0].pane_id;

await call('pane.send_text', { pane_id: firstPane, text: 'echo spike-$((40+2))\n' });
await sleep(1500);
show(
  'pane.read after echo',
  await call('pane.read', { pane_id: firstPane, source: 'recent', lines: 10 }),
);

const split = await call('pane.split', {
  target_pane_id: firstPane,
  direction: 'right',
  cwd: scratch,
  focus: false,
});
show('pane.split', split);
const dockerPane = split.pane.pane_id;

// `exec` makes the container the pane's own process, so the pane exits when it does.
await call('pane.send_text', {
  pane_id: dockerPane,
  text: `exec docker run --rm -it --add-host=host.docker.internal:host-gateway ${dockerImage} sh -c 'echo in-container; sleep 4; exit 3'\n`,
});
await sleep(2500);
show('pane.process_info (docker)', await call('pane.process_info', { pane_id: dockerPane }));
show('pane.get (docker)', await call('pane.get', { pane_id: dockerPane }));
show(
  'pane.read (docker)',
  await call('pane.read', { pane_id: dockerPane, source: 'recent', lines: 10 }),
);
await sleep(6000);
show('events after container exit', events);
show('pane.list after exit', await call('pane.list', { workspace_id: workspaceId }));

show(
  'worktree.remove',
  await call('worktree.remove', { workspace_id: workspaceId, force: true, trust_repository: true }),
);
await sleep(500);
show('workspace.list', await call('workspace.list'));
show('events at end', events);
unsubscribe();
