// End-to-end check of the orchestration against a real Herdr session, with a stub agent and a
// local git repository instead of Docker, Claude and GitHub. Usage:
//   herdr --session factory server &      node scripts/smoke.ts [session]
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applications } from '../src/app.ts';
import { configuration } from '../src/config.ts';
import { Core } from '../src/core.ts';
import type { Run } from '../src/domain.ts';
import { HerdrClient } from '../src/herdr/client.ts';
import { HerdrRuntime } from '../src/herdr/runtime.ts';
import { Pipeline } from '../src/pipeline.ts';
import { FileRunStore } from '../src/store.ts';
import { FakeGitHub, issue } from '../src/testing.ts';

const home = realpathSync(mkdtempSync(join(tmpdir(), 'factory-smoke-')));
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });
const origin = join(home, 'origin.git');
const clone = join(home, 'repos', 'example', 'smoke');
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
execFileSync('git', ['clone', '-q', origin, clone], { stdio: 'pipe' });
git(
  clone,
  '-c',
  'user.name=smoke',
  '-c',
  'user.email=smoke@example.invalid',
  'commit',
  '-q',
  '--allow-empty',
  '-m',
  'init',
);
git(clone, 'push', '-q', 'origin', 'HEAD:main');

const mcpPort = 38_776;
const config = {
  ...configuration({
    FACTORY_HOME: home,
    HERDR_SESSION: process.argv[2] ?? 'factory',
    FACTORY_MCP_PORT: String(mcpPort),
    FACTORY_MCP_PUBLIC_URL: `http://127.0.0.1:${mcpPort}`,
    FACTORY_AGENT_COMMAND: `node ${fileURLToPath(new URL('./stub-agent.mjs', import.meta.url))}`,
  }),
};
const core = new Core(new FileRunStore(join(home, 'runs')));
const runtime = new HerdrRuntime(new HerdrClient(config.herdrSocket), config);
await runtime.connect();
const github = new FakeGitHub();
github.syncRepository = async () => clone;
const pipeline = new Pipeline(core, runtime, github, config);
const unused = async (): Promise<never> => {
  throw new Error('not used');
};
const apps = applications({
  core,
  config,
  ready: () => true,
  issue: unused,
  submit: unused,
  retry: unused,
  cancel: unused,
  tail: unused,
  poll: unused,
  intake: () => ({ lastPollAt: null, lastError: null }),
});
const server = apps.mcp.listen(mcpPort, '127.0.0.1');
await once(server, 'listening');
await pipeline.start();

core.on('change', (run) => {
  const stage = run.stages.at(-1);
  console.log(
    `${run.status.padEnd(8)} ${stage ? `${stage.name}#${stage.attempt} ${stage.status} ${stage.paneId ?? ''}` : ''}`,
  );
});
const run = await pipeline.submit(
  github.add(issue({ repo: 'example/smoke', url: 'https://github.com/example/smoke/issues/7' })),
);
const finished = await new Promise<Run>((resolve, reject) => {
  const timeout = setTimeout(
    () => reject(new Error('The run did not finish within 90 seconds.')),
    90_000,
  );
  core.on('change', (current) => {
    if (current.id === run.id && ['done', 'failed', 'needs_input'].includes(current.status)) {
      clearTimeout(timeout);
      resolve(current);
    }
  });
});

// Let the pipeline finish its clean-up (close panes, remove the worktree, label the issue).
await new Promise((resolve) => setTimeout(resolve, 3000));
const stages = finished.stages.map((stage) => `${stage.name}:${stage.status}`).join(' ');
const committed = git(clone, 'log', '--oneline', finished.branch)
  .toString()
  .trim()
  .split('\n').length;
console.log(`\nresult: ${finished.status} | ${stages}`);
console.log(
  `pr: ${finished.prUrl} | commits on ${finished.branch}: ${committed} | labels: ${github.labels(7, 'example/smoke')}`,
);
pipeline.stop();
runtime.close();
server.closeAllConnections();
server.close();
const expected =
  'classify:done plan:done plan-review:changes_requested plan:done plan-review:done implement:done review:done pr:done';
const labels = github.labels(7, 'example/smoke').join(',');
const leftover = (
  await new HerdrClient(config.herdrSocket).call<{ workspaces: Array<{ label: string }> }>(
    'workspace.list',
  )
).workspaces.filter((workspace) => workspace.label.startsWith('#7 ')).length;
if (
  finished.status !== 'done' ||
  stages !== expected ||
  committed !== 2 ||
  labels !== 'factory:done' ||
  leftover !== 0
) {
  console.error(`SMOKE FAILED (expected: ${expected})`);
  process.exit(1);
}
console.log('SMOKE PASSED');
process.exit(0);
