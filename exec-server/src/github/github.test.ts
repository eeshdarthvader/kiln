import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Core } from '../core.ts';
import type { Issue, Run } from '../domain.ts';
import { MemoryRunStore } from '../store.ts';
import { FakeGitHub, issue, testConfig } from '../testing.ts';
import { GhCli } from './gh.ts';
import { Intake } from './intake.ts';

function recorder(replies: Record<string, string>) {
  const calls: Array<{ line: string; input?: string }> = [];
  const run = async (command: string, args: string[], input?: string) => {
    const line = `${command} ${args.join(' ')}`;
    calls.push(input === undefined ? { line } : { line, input });
    const key = Object.keys(replies).find((prefix) => line.startsWith(prefix));
    return key ? replies[key]! : '';
  };
  return { calls, run };
}
const raw = {
  number: 7,
  title: 'Add a health route',
  body: null,
  url: 'u',
  state: 'OPEN',
  labels: [{ name: 'factory' }, { name: 'bug' }],
};

test('gh output is mapped to issues and commands never go through a shell', async () => {
  const { calls, run } = recorder({
    'gh issue view': JSON.stringify(raw),
    'gh issue list': JSON.stringify([raw]),
    'gh repo view': 'main\n',
    'gh pr list': '\n',
  });
  const github = new GhCli('/tmp/factory-repos-missing', run);
  assert.deepEqual(await github.issue('acme/widgets', 7), {
    repo: 'acme/widgets',
    number: 7,
    title: 'Add a health route',
    body: '',
    url: 'u',
    labels: ['factory', 'bug'],
    state: 'open',
  });
  assert.equal((await github.labelledIssues('acme/widgets', 'factory')).length, 1);
  assert.equal(await github.defaultBranch('acme/widgets'), 'main');
  assert.equal(await github.pullRequestForBranch('acme/widgets', 'factory/7-x'), null);
  await github.comment('acme/widgets', 7, 'Body with `backticks` and $(subshell)');
  assert.deepEqual(calls.at(-1), {
    line: 'gh issue comment 7 --repo acme/widgets --body-file -',
    input: 'Body with `backticks` and $(subshell)',
  });
});

test('relabel creates missing labels once and only removes labels the issue carries', async () => {
  const { calls, run } = recorder({ 'gh issue view': JSON.stringify(raw) });
  const github = new GhCli('/tmp/factory-repos-missing', run);
  await github.relabel('acme/widgets', 7, ['factory:in-progress'], ['factory', 'factory:failed']);
  await github.relabel('acme/widgets', 7, ['factory:in-progress'], []);
  const lines = calls.map((call) => call.line);
  assert.equal(lines.filter((line) => line.startsWith('gh label create')).length, 1);
  assert.ok(
    lines.includes(
      'gh issue edit 7 --repo acme/widgets --add-label factory:in-progress --remove-label factory',
    ),
  );
});

test('syncRepository clones a repository it has not seen', async () => {
  const { calls, run } = recorder({});
  const path = await new GhCli('/tmp/factory-repos-missing', run).syncRepository('acme/widgets');
  assert.equal(path, '/tmp/factory-repos-missing/acme/widgets');
  assert.deepEqual(
    calls.map((call) => call.line),
    [`gh repo clone acme/widgets ${path}`],
  );
});

test('intake starts labelled issues once and restarts stopped runs that were re-labelled', async () => {
  const core = new Core(new MemoryRunStore());
  const github = new FakeGitHub();
  const submitted: number[] = [];
  const submit = async (value: Issue): Promise<Run> => {
    submitted.push(value.number);
    return core.create(value);
  };
  const intake = new Intake(core, github, testConfig(), submit);
  github.add(issue({ number: 1 }));
  github.add(issue({ number: 2, labels: ['bug'] }));
  github.add(issue({ number: 3, repo: 'other/repo' }));

  assert.equal((await intake.poll()).length, 1);
  assert.deepEqual(submitted, [1]);
  await intake.poll();
  assert.deepEqual(submitted, [1], 'a queued run is not submitted again');

  core.update(core.findByIssue('acme/widgets', 1)!.id, (run) => void (run.status = 'needs_input'));
  await intake.poll();
  assert.deepEqual(submitted, [1, 1], 'the label on a stopped run asks for another attempt');
  assert.equal(intake.lastError, null);

  github.failing = true;
  assert.deepEqual(await intake.poll(), []);
  assert.match(intake.lastError ?? '', /acme\/widgets: gh is offline/);
});
