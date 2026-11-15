import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { RuntimeCommandError } from '../ports.ts';
import { OpenCodeClient } from './client.ts';

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sawd-opencode-')));
  const state = {
    messages: [] as Record<string, unknown>[],
    inbox: [] as Record<string, unknown>[],
    sessionPages: [[]] as Record<string, unknown>[][],
    sessionInfo: {} as Record<string, unknown>,
    sessionCursor: undefined as string | undefined,
    discoveryFailures: [] as (number | 'disconnect')[],
    providers: {
      data: [
        { id: 'configured', name: 'configured', activation: 'enabled' },
        { id: 'disabled', name: 'disabled', activation: 'disabled' },
      ],
    } as unknown,
    models: {
      data: [
        ['model', true, true, ['text'], ['text']],
        ['disabled', false, true, ['text'], ['text']],
        ['chat', true, false, ['text'], ['text']],
        ['image', true, true, ['text'], ['image']],
        ['audio', true, true, ['audio'], ['text']],
      ].map(([id, enabled, tools, input, output]) => ({
        id,
        name: id,
        providerID: 'configured',
        enabled,
        capabilities: { tools, input, output },
      })),
    } as unknown,
    promptFailure: undefined as number | 'disconnect' | 'json' | undefined,
    promptResponse: undefined as unknown,
    promptPersistence: 'none' as 'none' | 'inbox' | 'message',
    promptCount: 0,
    readFailure: undefined as number | undefined,
    onInboxRead: undefined as (() => void) | undefined,
    registration: [{ name: 'sawd-execution', status: { status: 'connected' } }] as unknown,
    registrationStatuses: [] as string[],
    calls: [] as {
      path: string;
      method: string;
      query: Record<string, string>;
      authorization?: string;
      body: any;
    }[],
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    state.calls.push({
      path: url.pathname,
      method: request.method!,
      query: Object.fromEntries(url.searchParams),
      authorization: request.headers.authorization,
      body,
    });
    let value: unknown;
    if (url.pathname === '/api/provider') {
      const failure = state.discoveryFailures.shift();
      if (failure === 'disconnect') return request.socket.destroy();
      if (failure) return response.writeHead(failure).end('private discovery response');
      value = state.providers;
    } else if (url.pathname === '/api/model') value = state.models;
    else if (url.pathname === '/api/experimental/mcp/sawd-execution')
      return response.writeHead(204).end();
    else if (url.pathname === '/api/mcp') {
      const status = state.registrationStatuses.shift();
      if (status) state.registration = [{ name: 'sawd-execution', status: { status } }];
      value = { data: state.registration };
    } else if (url.pathname === '/api/session') {
      if (request.method === 'POST')
        value = {
          data: {
            id: 'ses_root',
            location: body.location,
            model: body.model,
            ...state.sessionInfo,
          },
        };
      else {
        const page = Number(url.searchParams.get('cursor')?.replace('page-', '') ?? 0);
        value = {
          data: state.sessionPages[page] ?? [],
          cursor: {
            next:
              state.sessionCursor ??
              (page + 1 < state.sessionPages.length ? `page-${page + 1}` : null),
          },
        };
      }
    } else if (url.pathname.endsWith('/model')) return response.writeHead(204).end();
    else if (url.pathname.endsWith('/inbox')) {
      state.onInboxRead?.();
      if (state.readFailure)
        return response.writeHead(state.readFailure).end('private read response');
      value = { data: state.inbox };
    } else if (url.pathname.includes('/message/')) {
      const id = decodeURIComponent(url.pathname.split('/').at(-1)!);
      const message = state.messages.find((candidate) => candidate.id === id);
      if (!message) return response.writeHead(404).end('private missing response');
      value = { data: message };
    } else if (url.pathname.endsWith('/prompt')) {
      state.promptCount++;
      const admitted = {
        id: body.id,
        sessionID: url.pathname.split('/')[3],
        type: 'user',
        payload: { text: body.text },
        delivery: 'steer',
        time: { created: Date.now() },
      };
      if (state.promptPersistence === 'inbox') state.inbox.push(admitted);
      if (state.promptPersistence === 'message')
        state.messages.push({ id: body.id, type: 'user', text: body.text });
      if (state.promptFailure === 'disconnect') return request.socket.destroy();
      if (state.promptFailure === 'json')
        return response.writeHead(200).end('private malformed JSON');
      if (state.promptFailure)
        return response.writeHead(state.promptFailure).end('private runtime token');
      value = state.promptResponse ?? { data: admitted };
    } else return response.writeHead(404).end();
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const client = new OpenCodeClient({
    url: `http://127.0.0.1:${port}`,
    password: 'secret',
    workspaceRoot: root,
  });
  const command = {
    kind: 'launch' as const,
    commandId: 'start',
    threadId: 'logical',
    taskId: 'task',
    message: 'Implement',
    task: {
      title: 'Task',
      modelSelection: { instanceId: 'configured', model: 'model' },
      workspacePath: join(root, 'task'),
    },
  };
  return {
    root,
    url: `http://127.0.0.1:${port}`,
    state,
    client,
    command,
    async close() {
      client.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

const isUnknown = (error: unknown) =>
  error instanceof RuntimeCommandError && error.outcome === 'unknown';

test('discovery combines V2 providers and enabled text tool models by provider ID', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const discovered = await f.client.discover();
  assert.equal(discovered.taskWorkspaceRoot, f.root);
  assert.deepEqual(discovered.providers, [
    {
      id: 'configured',
      driver: 'opencode',
      name: 'configured',
      available: true,
      models: [{ id: 'model', name: 'model' }],
    },
  ]);
  assert.deepEqual(f.state.calls.map((call) => call.path).sort(), ['/api/model', '/api/provider']);
  assert.ok(f.state.calls.every((call) => call.query['location[directory]'] === f.root));
});

test('discovery retries transient failures with bounded read-only attempts', async (t) => {
  for (const failure of [503, 'disconnect'] as const) {
    await t.test(String(failure), async (t) => {
      const f = await fixture();
      t.after(f.close);
      f.state.discoveryFailures = [failure];
      assert.equal((await f.client.discover()).providers[0]!.models[0]!.id, 'model');
      assert.equal(f.state.calls.filter((call) => call.path === '/api/provider').length, 2);
      assert.ok(f.state.calls.every((call) => call.method === 'GET'));
    });
  }
});

test('discovery never retries rejected requests and sanitizes upstream errors', async (t) => {
  for (const [status, attempts] of [
    [503, 3],
    [401, 1],
  ] as const) {
    const f = await fixture();
    t.after(f.close);
    f.state.discoveryFailures = [status, status, status, status];
    await assert.rejects(
      f.client.discover(),
      (error: unknown) =>
        error instanceof RuntimeCommandError &&
        error.outcome === (status === 503 ? 'unknown' : 'rejected') &&
        !error.message.includes('private discovery response'),
    );
    assert.equal(f.state.calls.filter((call) => call.path === '/api/provider').length, attempts);
  }
});

test('discovery rejects malformed V2 envelopes and capabilities', async (t) => {
  for (const models of [
    [],
    { data: {} },
    {
      data: [
        { enabled: true, capabilities: { tools: true, input: { text: true }, output: ['text'] } },
      ],
    },
  ]) {
    const f = await fixture();
    t.after(f.close);
    f.state.models = models;
    await assert.rejects(f.client.discover(), /Unexpected OpenCode/);
  }
});

test('registers reporting by location and creates a V2 session with its selected model', async (t) => {
  const f = await fixture();
  t.after(f.close);
  await f.client.registerReporting('http://localhost:3000/mcp');
  const prepared = await f.client.prepare(f.command);
  assert.deepEqual(await f.client.prepare(f.command), prepared);
  await f.client.deliver(prepared);
  const calls = f.state.calls.length;
  await f.client.deliver(prepared);
  assert.equal(await f.client.reconcile(prepared), true);
  assert.equal(f.state.calls.length, calls);
  assert.equal(f.state.promptCount, 1);
  const registrations = f.state.calls.filter((call) => call.method === 'PUT');
  assert.equal(registrations.length, 2);
  assert.deepEqual(
    registrations.map((call) => call.query),
    [{ 'location[directory]': f.root }, { 'location[directory]': f.command.task.workspacePath }],
  );
  assert.deepEqual(registrations[0]!.body, {
    config: { type: 'remote', url: 'http://localhost:3000/mcp', oauth: false, disabled: false },
  });
  assert.deepEqual(registrations[1]!.body, {
    config: {
      type: 'remote',
      url: 'http://localhost:3000/mcp/tasks/task',
      oauth: false,
      disabled: false,
    },
  });
  const create = f.state.calls.find(
    (call) => call.path === '/api/session' && call.method === 'POST',
  )!;
  assert.deepEqual(create.query, {});
  assert.deepEqual(create.body, {
    title: 'Task',
    location: { directory: f.command.task.workspacePath },
    model: { providerID: 'configured', id: 'model' },
    metadata: { sawdThreadId: 'logical' },
  });
  const prompt = f.state.calls.find((call) => call.path.endsWith('/prompt'))!;
  assert.deepEqual(prompt.body, { id: prepared.payload.messageID, text: 'Implement' });
  assert.deepEqual(prompt.query, {});
  assert.ok(
    f.state.calls.every(
      (call) => call.authorization === `Basic ${Buffer.from('opencode:secret').toString('base64')}`,
    ),
  );
});

test('concurrent task directories bind distinct reporting URLs outside the prompt', async (t) => {
  const f = await fixture();
  t.after(f.close);
  await f.client.registerReporting('http://localhost:3000/mcp/');
  const commands = ['task-A', 'task-B'].map((taskId) => ({
    ...f.command,
    taskId,
    commandId: `${taskId}:start`,
    threadId: taskId,
    task: { ...f.command.task, workspacePath: join(f.root, taskId) },
  }));
  await Promise.all(commands.map((command) => f.client.prepare(command)));
  const registrations = f.state.calls.filter((call) => call.method === 'PUT');
  assert.equal(registrations.length, 3);
  assert.equal(registrations[0]!.body.config.url, 'http://localhost:3000/mcp');
  for (const command of commands) {
    const registration = registrations.find(
      (call) => call.query['location[directory]'] === command.task.workspacePath,
    );
    assert.equal(
      registration?.body.config.url,
      `http://localhost:3000/mcp/tasks/${command.taskId}`,
    );
  }
});

test('reconnecting rebinds an adopted task session to its encoded reporting URL', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const reconnect = new OpenCodeClient({ url: f.url, workspaceRoot: f.root });
  t.after(() => reconnect.close());
  const command = { ...f.command, taskId: 'task/with ?#' };
  f.state.sessionPages = [
    [
      {
        id: 'ses_existing',
        location: { directory: command.task.workspacePath },
        metadata: { sawdThreadId: command.threadId },
        model: { providerID: 'configured', id: 'model' },
      },
    ],
  ];
  await reconnect.registerReporting('http://localhost:3000/mcp');
  const prepared = await reconnect.prepare(command);
  assert.equal(prepared.payload.id, 'ses_existing');
  assert.deepEqual(
    f.state.calls.filter((call) => call.method === 'PUT').map((call) => call.body.config.url),
    ['http://localhost:3000/mcp', 'http://localhost:3000/mcp/tasks/task%2Fwith%20%3F%23'],
  );
  assert.equal(
    f.state.calls.some((call) => call.method === 'POST'),
    false,
  );
});

test('lost or malformed prompt responses reconcile from durable inbox or message without replay', async (t) => {
  for (const persistence of ['inbox', 'message'] as const) {
    for (const failure of ['disconnect', 'json'] as const) {
      await t.test(`${persistence}-${failure}`, async (t) => {
        const f = await fixture();
        t.after(f.close);
        f.state.promptPersistence = persistence;
        f.state.promptFailure = failure;
        const prepared = await f.client.prepare(f.command);
        await assert.rejects(f.client.deliver(prepared), isUnknown);
        await f.client.deliver(prepared);
        assert.equal(await f.client.reconcile(prepared), true);
        assert.equal(f.state.promptCount, 1);
      });
    }
  }
});

test('uncertain admission remains unknown and never submits again without durable evidence', async (t) => {
  const f = await fixture();
  t.after(f.close);
  f.state.promptFailure = 'disconnect';
  const prepared = await f.client.prepare(f.command);
  await assert.rejects(f.client.deliver(prepared), isUnknown);
  await assert.rejects(f.client.deliver(prepared), isUnknown);
  assert.equal(await f.client.reconcile(prepared), false);
  f.state.readFailure = 403;
  await assert.rejects(f.client.deliver(prepared), isUnknown);
  f.state.readFailure = undefined;
  f.state.messages.push({ id: prepared.payload.messageID, type: 'user', text: 'Implement' });
  assert.equal(await f.client.reconcile(prepared), true);
  assert.equal(f.state.promptCount, 1);
});

test('invalid prompt acknowledgements cannot prove admission', async (t) => {
  for (const response of [
    {},
    { data: {} },
    {
      data: {
        id: 'msg_wrong',
        sessionID: 'ses_root',
        type: 'user',
        payload: { text: 'Implement' },
      },
    },
  ]) {
    const f = await fixture();
    t.after(f.close);
    f.state.promptResponse = response;
    const prepared = await f.client.prepare(f.command);
    await assert.rejects(f.client.deliver(prepared), isUnknown);
    await assert.rejects(f.client.deliver(prepared), isUnknown);
    assert.equal(f.state.promptCount, 1);
  }
});

test('wrong message type, session, or payload cannot prove admission', async (t) => {
  for (const mismatch of [
    { type: 'synthetic' },
    { sessionID: 'ses_foreign' },
    { payload: { text: 'other' } },
  ]) {
    const f = await fixture();
    t.after(f.close);
    const prepared = await f.client.prepare(f.command);
    f.state.inbox.push({
      id: prepared.payload.messageID,
      sessionID: 'ses_root',
      type: 'user',
      payload: { text: 'Implement' },
      ...mismatch,
    });
    await assert.rejects(f.client.deliver(prepared), isUnknown);
    assert.equal(f.state.promptCount, 0);
  }
});

test('upstream prompt rejection is sanitized and never replayed', async (t) => {
  const f = await fixture();
  t.after(f.close);
  f.state.promptFailure = 401;
  const prepared = await f.client.prepare(f.command);
  await assert.rejects(
    f.client.deliver(prepared),
    (error: unknown) =>
      error instanceof RuntimeCommandError &&
      error.outcome === 'rejected' &&
      error.message === 'OpenCode request failed (HTTP 401).',
  );
  await assert.rejects(f.client.deliver(prepared), isUnknown);
  assert.equal(f.state.promptCount, 1);
});

test('checks inbox before message promotion and accepts user records without assistant activity', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const prepared = await f.client.prepare(f.command);
  f.state.onInboxRead = () => {
    f.state.messages.push({ id: prepared.payload.messageID, type: 'user', text: 'Implement' });
  };
  assert.equal(await f.client.reconcile(prepared), true);
  assert.equal(f.state.promptCount, 0);
});

test('adopts a session on a later page and sets its model before delivery', async (t) => {
  const f = await fixture();
  t.after(f.close);
  f.state.sessionPages = [
    [
      {
        id: 'ses_unrelated',
        location: { directory: f.command.task.workspacePath },
      },
    ],
    [
      {
        id: 'ses_existing',
        location: { directory: f.command.task.workspacePath },
        metadata: { sawdThreadId: 'logical' },
        model: { providerID: 'other', id: 'old' },
      },
    ],
  ];
  assert.equal((await f.client.prepare(f.command)).payload.id, 'ses_existing');
  const lists = f.state.calls.filter((call) => call.path === '/api/session');
  assert.equal(lists.length, 2);
  assert.deepEqual(
    lists.map((call) => call.query),
    [
      { directory: f.command.task.workspacePath, parentID: 'null' },
      { directory: f.command.task.workspacePath, parentID: 'null', cursor: 'page-1' },
    ],
  );
  assert.deepEqual(f.state.calls.at(-1)!.body, {
    model: { providerID: 'configured', id: 'model' },
  });
  assert.equal(f.state.calls.at(-1)!.path, '/api/session/ses_existing/model');
  assert.ok(lists.every((call) => call.method === 'GET'));
});

test('detects ambiguous sessions across pages and repeated pagination cursors', async (t) => {
  for (const mode of ['ambiguous', 'cursor'] as const) {
    await t.test(mode, async (t) => {
      const f = await fixture();
      t.after(f.close);
      const candidate = {
        id: 'ses_match',
        location: { directory: f.command.task.workspacePath },
        metadata: { sawdThreadId: 'logical' },
      };
      if (mode === 'ambiguous') f.state.sessionPages = [[candidate], [candidate]];
      else f.state.sessionCursor = 'page-0';
      await assert.rejects(
        f.client.prepare(f.command),
        mode === 'ambiguous' ? /Multiple/ : /repeated/,
      );
      assert.equal(
        f.state.calls.some((call) => call.method === 'POST'),
        false,
      );
    });
  }
});

test('rejects foreign or child roots returned by session creation', async (t) => {
  for (const sessionInfo of [{ location: { directory: '/outside' } }, { parentID: 'ses_other' }]) {
    const f = await fixture();
    t.after(f.close);
    f.state.sessionInfo = sessionInfo;
    await assert.rejects(f.client.prepare(f.command), RuntimeCommandError);
  }
});

test('adoption keeps an already selected model', async (t) => {
  const f = await fixture();
  t.after(f.close);
  f.state.sessionPages = [
    [
      {
        id: 'ses_existing',
        location: { directory: f.command.task.workspacePath },
        metadata: { sawdThreadId: 'logical' },
        model: { providerID: 'configured', id: 'model' },
      },
    ],
  ];
  await f.client.prepare(f.command);
  assert.equal(
    f.state.calls.some((call) => call.method === 'POST'),
    false,
  );
});

test('adoption resets a previous variant to the selected default model', async (t) => {
  const f = await fixture();
  t.after(f.close);
  f.state.sessionPages = [
    [
      {
        id: 'ses_existing',
        location: { directory: f.command.task.workspacePath },
        metadata: { sawdThreadId: 'logical' },
        model: { providerID: 'configured', id: 'model', variant: 'high' },
      },
    ],
  ];
  await f.client.prepare(f.command);
  assert.equal(f.state.calls.at(-1)!.path, '/api/session/ses_existing/model');
  assert.deepEqual(f.state.calls.at(-1)!.body, {
    model: { providerID: 'configured', id: 'model' },
  });
});

test('runtime links encode the public server URL and retain its base path', async (t) => {
  const f = await fixture();
  t.after(f.close);
  assert.equal(f.client.getSessionUrl('logical', 'https://runtime.example/opencode/'), null);
  await f.client.prepare(f.command);
  const url = new URL(f.client.getSessionUrl('logical', 'https://runtime.example/opencode/')!);
  const [, prefix, kind, encoded, sessionKind, session] = url.pathname.split('/');
  assert.equal(prefix, 'opencode');
  assert.equal(kind, 'server');
  assert.equal(sessionKind, 'session');
  assert.equal(session, 'ses_root');
  assert.equal(Buffer.from(encoded!, 'base64url').toString(), 'https://runtime.example/opencode');
  assert.equal(url.username, '');
  assert.equal(url.password, '');
  assert.equal(url.search, '');
});

test('rejects traversal and escaping symlinks before contacting runtime', async (t) => {
  const f = await fixture();
  t.after(f.close);
  await assert.rejects(
    f.client.prepare({ ...f.command, task: { ...f.command.task, workspacePath: tmpdir() } }),
    /inside/,
  );
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'sawd-outside-')));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, f.command.task.workspacePath);
  await assert.rejects(f.client.prepare(f.command), /escapes/);
  assert.deepEqual(f.state.calls, []);
});

test('registration requires a connected matching server', async (t) => {
  for (const registration of [
    [],
    [{ name: 'sawd-execution', status: { status: 'failed' } }],
    [{ name: 'sawd-execution', status: { status: 'needs_auth' } }],
    [{ name: 'other', status: { status: 'connected' } }],
  ]) {
    const f = await fixture();
    t.after(f.close);
    f.state.registration = registration;
    await assert.rejects(
      f.client.registerReporting('http://localhost:3000/mcp'),
      /could not connect/,
    );
    assert.equal(f.state.calls.filter((call) => call.path === '/api/mcp').length, 1);
  }
});

test('registration waits for pending connections without repeating the write', async (t) => {
  const f = await fixture();
  t.after(f.close);
  f.state.registrationStatuses = ['pending', 'pending', 'connected'];
  await f.client.registerReporting('http://localhost:3000/mcp');
  assert.equal(f.state.calls.filter((call) => call.path === '/api/mcp').length, 3);
  assert.equal(f.state.calls.filter((call) => call.method === 'PUT').length, 1);
});

test('registration stops observing a connection that stays pending', async (t) => {
  const f = await fixture();
  t.after(f.close);
  f.state.registrationStatuses = ['pending'];
  await assert.rejects(
    f.client.registerReporting('http://localhost:3000/mcp'),
    /could not connect/,
  );
  assert.equal(f.state.calls.filter((call) => call.path === '/api/mcp').length, 6);
  assert.equal(f.state.calls.filter((call) => call.method === 'PUT').length, 1);
});

test('transport rejects credential-bearing and non-HTTP endpoints', () => {
  for (const url of [
    'file:///tmp',
    'http://user:secret@localhost',
    'http://localhost/?token=secret',
    'http://localhost/#secret',
  ])
    assert.throws(() => new OpenCodeClient({ url, workspaceRoot: '/tmp/sawd' }), /OPENCODE_URL/);
});
