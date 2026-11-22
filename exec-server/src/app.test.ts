import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { applications } from './app.ts';
import type { Config } from './config.ts';
import { Core } from './core.ts';
import { Pipeline } from './pipeline.ts';
import { MemoryRunStore } from './store.ts';
import { FakeGitHub, FakeRuntime, eventually, issue, testConfig } from './testing.ts';

async function serve(t: TestContext, overrides: Partial<Config> = {}) {
  const config = testConfig(overrides);
  const core = new Core(new MemoryRunStore());
  const runtime = new FakeRuntime(config.home);
  const github = new FakeGitHub();
  const pipeline = new Pipeline(core, runtime, github, config, { exitGraceMs: 10, stopDelayMs: 0 });
  let ready = true;
  const apps = applications({
    core,
    config,
    ready: () => ready,
    issue: (repo, number) => github.issue(repo, number),
    submit: (value) => pipeline.submit(value),
    retry: (id) => pipeline.retry(id),
    cancel: (id) => pipeline.cancel(id),
    approve: (id) => pipeline.approve(id),
    reject: (id, feedback) => pipeline.reject(id, feedback),
    tail: (id) => pipeline.tail(id),
    poll: async () => [],
    intake: () => ({ lastPollAt: null, lastError: null }),
  });
  await pipeline.start();
  const listen = async (application: typeof apps.app) => {
    const server = application.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  };
  t.after(() => pipeline.stop());
  const api = await listen(apps.app);
  const mcp = await listen(apps.mcp);
  const request = (path: string, init: RequestInit & { token?: string } = {}) =>
    fetch(`${api}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      },
    });
  return {
    core,
    runtime,
    github,
    api,
    mcp,
    request,
    setReady: (value: boolean) => (ready = value),
  };
}

async function tools(t: TestContext, url: string) {
  const client = new Client({ name: 'test-agent', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  t.after(() => client.close());
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const [content] = result.content as Array<{ text: string }>;
    return {
      isError: result.isError === true,
      body: name === 'get_reporting_instructions' ? content!.text : JSON.parse(content!.text),
    };
  };
  return { client, call };
}

test('adding an issue URL starts a run that an agent advances through the reporting MCP', async (t) => {
  const { core, runtime, github, mcp, request } = await serve(t);
  github.add(issue());
  const created = await request('/v1/runs', {
    method: 'POST',
    body: JSON.stringify({ issueUrl: 'https://github.com/acme/widgets/issues/7' }),
  });
  assert.equal(created.status, 202);
  const run = (await created.json()) as { id: string };
  await eventually(() => assert.equal(runtime.started.length, 1));

  const agent = await tools(t, `${mcp}/mcp/runs/${run.id}/stages/classify`);
  assert.deepEqual((await agent.client.listTools()).tools.map((tool) => tool.name).sort(), [
    'create_attachment',
    'get_reporting_instructions',
    'report_status',
  ]);
  assert.match((await agent.call('get_reporting_instructions', {})).body, /report_status/);
  const reported = await agent.call('report_status', {
    operationId: 'op-1',
    report: { status: 'done', summary: 'Ready to build.' },
  });
  assert.equal(reported.isError, false);
  assert.equal(reported.body.stage, 'classify');
  await eventually(() => assert.equal(runtime.last.stage, 'plan'));

  const stale = await agent.call('report_status', {
    operationId: 'op-2',
    report: { status: 'done', summary: 'Again.' },
  });
  assert.equal(stale.isError, true);
  assert.equal(stale.body.error.code, 'RUN_STATE_CONFLICT');

  const detail = (await (await request(`/v1/runs/${run.id}`)).json()) as {
    stages: unknown[];
    status: string;
  };
  assert.equal(detail.status, 'running');
  assert.equal(detail.stages.length, 2);
  const tail = (await (await request(`/v1/runs/${run.id}/tail`)).json()) as {
    stage: string;
    text: string;
  };
  assert.deepEqual(tail, { stage: 'plan', text: `output of ${runtime.last.paneId}` });
  const cancelled = (await (
    await request(`/v1/runs/${run.id}/cancel`, { method: 'POST' })
  ).json()) as { status: string };
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(core.list().length, 1);
});

test('the reporting MCP exposes write tools only on a stage URL of an existing run', async (t) => {
  const { mcp } = await serve(t);
  const general = await tools(t, `${mcp}/mcp`);
  assert.deepEqual(
    (await general.client.listTools()).tools.map((tool) => tool.name),
    ['get_reporting_instructions'],
  );
  const post = (path: string) =>
    fetch(`${mcp}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
  assert.equal((await post('/mcp/runs/missing/stages/plan')).status, 404);
  assert.equal((await fetch(`${mcp}/mcp`)).status, 405);
});

test('bad input, unknown runs and unreadiness return JSON errors', async (t) => {
  const { request, setReady } = await serve(t);
  const bad = await request('/v1/runs', {
    method: 'POST',
    body: JSON.stringify({ issueUrl: 'https://example.com/x' }),
  });
  assert.equal(bad.status, 400);
  assert.equal(((await bad.json()) as { error: { code: string } }).error.code, 'VALIDATION_FAILED');
  assert.equal((await request('/v1/runs/nope')).status, 404);
  assert.equal((await request('/v1/nothing')).status, 404);
  const factory = (await (await request('/v1/factory')).json()) as {
    repos: string[];
    label: string;
  };
  assert.deepEqual([factory.repos, factory.label], [['acme/widgets'], 'factory']);
  setReady(false);
  assert.equal((await request('/readyz')).status, 503);
  assert.equal((await request('/v1/poll', { method: 'POST' })).status, 503);
  assert.equal((await request('/v1/runs')).status, 200);
});

test('with an API token every /v1 route needs it, and health checks do not', async (t) => {
  const { request } = await serve(t, { apiToken: 'test-secret' });
  assert.equal((await request('/v1/runs')).status, 401);
  assert.equal((await request('/v1/runs', { token: 'wrong-secret' })).status, 401);
  assert.equal((await request('/v1/runs', { token: 'test-secret' })).status, 200);
  assert.equal((await request('/healthz')).status, 200);
});

test('the event stream pushes each run change', async (t) => {
  const { core, api } = await serve(t);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(`${api}/v1/events`, { signal: controller.signal });
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const run = core.create(issue());
  while (!text.includes('event: run')) text += decoder.decode((await reader.read()).value);
  const payload = JSON.parse(/data: (.*)\n/.exec(text)![1]!) as { id: string; plan?: unknown };
  assert.equal(payload.id, run.id);
  assert.equal(payload.plan, undefined, 'events carry summaries only');
});
