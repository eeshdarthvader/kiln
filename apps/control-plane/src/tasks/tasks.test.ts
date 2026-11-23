import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Core } from '../core.ts';
import { Intake } from '../github/intake.ts';
import { Pipeline } from '../pipeline.ts';
import { MemoryRunStore } from '../store.ts';
import { FakeGitHub, FakeRuntime, eventually, testConfig } from '../testing.ts';
import { CommandProvider } from './command.ts';
import { JiraProvider } from './jira.ts';
import { loadProviders } from './providers.ts';

const jiraIssue = (key: string, extra: object = {}) => ({
  key,
  fields: {
    summary: 'Add a health route',
    description: 'Please add GET /healthz.',
    labels: ['factory'],
    project: { key: key.split('-')[0] },
    status: { statusCategory: { key: 'indeterminate' } },
    ...extra,
  },
});

function fakeJira() {
  const calls: Array<{ method: string; url: string; body?: unknown; auth: string | null }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({
      method: init?.method ?? 'GET',
      url,
      auth: headers.get('authorization'),
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    if (url.includes('/search/jql')) return Response.json({ issues: [jiraIssue('PROJ-12')] });
    if (url.includes('/issue/PROJ-12?')) return Response.json(jiraIssue('PROJ-12'));
    if (init?.method === 'PUT') return new Response(null, { status: 204 });
    return Response.json({ id: '1' }, { status: 201 });
  }) as typeof fetch;
  return { calls, impl };
}

const jira = (impl: typeof fetch) =>
  new JiraProvider({
    name: 'jira',
    baseUrl: 'https://acme.atlassian.net/',
    email: 'bot@acme.test',
    token: 'secret',
    repo: 'acme/widgets',
    repos: { OPS: 'acme/ops' },
    fetch: impl,
  });

test('Jira lists labelled tickets as issues in the mapped repository', async () => {
  const { calls, impl } = fakeJira();
  const [issue] = await jira(impl).labelled('factory');
  assert.equal(issue?.repo, 'acme/widgets');
  assert.equal(issue?.number, 12);
  assert.equal(issue?.url, 'https://acme.atlassian.net/browse/PROJ-12');
  assert.deepEqual(issue?.ticket, { provider: 'jira', key: 'PROJ-12' });
  assert.equal(issue?.state, 'open');
  const query = new URL(calls[0]!.url).searchParams.get('jql');
  assert.match(query!, /labels = "factory"/);
  assert.equal(calls[0]!.auth, `Basic ${Buffer.from('bot@acme.test:secret').toString('base64')}`);
});

test('Jira edits labels, comments, maps projects and parses URLs', async () => {
  const { calls, impl } = fakeJira();
  const provider = jira(impl);
  await provider.relabel('PROJ-12', ['factory:in-progress'], ['factory']);
  await provider.comment('PROJ-12', 'Pull request ready.');
  assert.deepEqual(calls[0]!.body, {
    update: { labels: [{ remove: 'factory' }, { add: 'factory:in-progress' }] },
  });
  assert.equal(calls[1]!.url.endsWith('/rest/api/2/issue/PROJ-12/comment'), true);
  assert.deepEqual(calls[1]!.body, { body: 'Pull request ready.' });
  assert.equal(provider.parseUrl('https://acme.atlassian.net/browse/PROJ-12?x=1'), 'PROJ-12');
  assert.equal(provider.parseUrl('https://github.com/a/b/issues/1'), null);
  await assert.rejects(provider.get('../etc'), /not a Jira issue key/);
});

test('a ticket run builds in the mapped repo and reports back to the tracker', async () => {
  const { calls, impl } = fakeJira();
  const provider = jira(impl);
  const config = testConfig({ repos: [] });
  const core = new Core(new MemoryRunStore());
  const github = new FakeGitHub();
  const runtime = new FakeRuntime(config.home);
  const pipeline = new Pipeline(core, runtime, github, config, {
    exitGraceMs: 10,
    stopDelayMs: 0,
    providers: new Map([[provider.name, provider]]),
  });
  await pipeline.start();
  const intake = new Intake(core, github, config, (issue) => pipeline.submit(issue), [provider]);
  const [run] = await intake.poll();
  assert.equal(run?.ticket?.key, 'PROJ-12');
  assert.equal(run?.branch.startsWith('factory/proj-12-'), true);
  await eventually(() => runtime.started.length > 0);
  const writes = calls.filter((call) => call.method !== 'GET');
  assert.ok(writes.some((call) => JSON.stringify(call.body).includes('factory:in-progress')));
  assert.equal(github.comments.length, 0, 'nothing is posted to GitHub for a ticket run');
  // A ticket and a GitHub issue with the same number are different runs.
  assert.equal(core.findByIssue('acme/widgets', 12), undefined);
  pipeline.stop();
});

test('the command provider speaks the list/get/relabel/comment protocol', async () => {
  const seen: Array<{ args: string[]; input?: string }> = [];
  const provider = new CommandProvider({
    name: 'linear',
    command: ['linear-bridge'],
    repo: 'acme/widgets',
    urlPattern: 'linear\\.app/acme/issue/([A-Z]+-\\d+)',
    run: async (_command, args, input) => {
      seen.push({ args, ...(input === undefined ? {} : { input }) });
      return args[0] === 'list'
        ? JSON.stringify([
            { key: 'ENG-7', title: 'Fix', url: 'https://linear.app/acme/issue/ENG-7' },
          ])
        : '';
    },
  });
  const [issue] = await provider.labelled('factory');
  assert.equal(issue?.ticket?.key, 'ENG-7');
  assert.equal(issue?.number, 7);
  await provider.relabel('ENG-7', ['a', 'b'], ['c']);
  await provider.comment('ENG-7', 'hello');
  assert.deepEqual(seen[1]!.args, ['relabel', 'ENG-7', 'a,b', 'c']);
  assert.deepEqual(seen[2], { args: ['comment', 'ENG-7'], input: 'hello' });
  assert.equal(provider.parseUrl('https://linear.app/acme/issue/ENG-7/fix'), 'ENG-7');
});

test('providers load from a file and tokens come from the environment', () => {
  const config = testConfig();
  const path = join(mkdtempSync(join(tmpdir(), 'providers-')), 'providers.json');
  writeFileSync(
    path,
    JSON.stringify({
      providers: [
        {
          name: 'jira',
          type: 'jira',
          baseUrl: 'https://acme.atlassian.net',
          email: 'a@b.c',
          tokenEnv: 'JIRA_TOKEN',
          repo: 'acme/widgets',
        },
        { name: 'bridge', type: 'command', command: ['node', 'x.mjs'], repo: 'acme/widgets' },
      ],
    }),
  );
  const env = { FACTORY_TASK_PROVIDERS: path, JIRA_TOKEN: 'secret' };
  assert.deepEqual(
    loadProviders(config, env).map((provider) => provider.name),
    ['jira', 'bridge'],
  );
  assert.throws(() => loadProviders(config, { FACTORY_TASK_PROVIDERS: path }), /JIRA_TOKEN/);
  assert.deepEqual(loadProviders(config, {}), []);
});
