import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test, type TestContext } from 'node:test';
import { applications } from './app.ts';
import { Core } from './core.ts';
import { MemoryRunStore } from './store.ts';
import { testConfig } from './testing.ts';

async function fixture(t: TestContext, uiDirectory: string) {
  const unused = async (): Promise<never> => {
    throw new Error('not used');
  };
  const server = applications(
    {
      core: new Core(new MemoryRunStore()),
      config: testConfig({ apiToken: 'test-secret' }),
      ready: () => true,
      issue: unused,
      submit: unused,
      retry: unused,
      cancel: unused,
      approve: unused,
      reject: unused,
      tail: unused,
      poll: unused,
      intake: () => ({ lastPollAt: null, lastError: null }),
    },
    uiDirectory,
  ).app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });

  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = (path: string, token?: string) =>
    fetch(`${base}${path}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  return { request };
}

test('built UI files are public while API paths retain bearer auth and JSON 404s', async (t) => {
  const uiDirectory = await mkdtemp(join(tmpdir(), 'factory-ui-'));
  t.after(() => rm(uiDirectory, { recursive: true, force: true }));
  await mkdir(join(uiDirectory, 'assets'));
  await writeFile(join(uiDirectory, 'index.html'), '<title>Factory</title>');
  await writeFile(join(uiDirectory, 'assets', 'main.js'), 'window.uiReady = true;');

  const { request } = await fixture(t, uiDirectory);
  const page = await request('/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Factory/);

  const asset = await request('/assets/main.js');
  assert.equal(asset.status, 200);
  assert.match(await asset.text(), /window\.uiReady/);

  assert.equal((await request('/v1/runs/missing')).status, 401);
  const unknownTask = await request('/v1/runs/missing', 'test-secret');
  assert.equal(unknownTask.status, 404);
  assert.deepEqual(await unknownTask.json(), {
    error: { code: 'RUN_NOT_FOUND', message: 'Run not found.' },
  });
  const unknownRoute = await request('/unknown', 'test-secret');
  assert.equal(unknownRoute.status, 404);
  assert.deepEqual(await unknownRoute.json(), {
    error: { code: 'ROUTE_NOT_FOUND', message: 'Route not found.' },
  });
  assert.equal((await request('/assets/missing.js', 'test-secret')).status, 404);
  const sourceFile = await request('/ui/main.tsx', 'test-secret');
  assert.equal(sourceFile.status, 404);
  assert.deepEqual(await sourceFile.json(), {
    error: { code: 'ROUTE_NOT_FOUND', message: 'Route not found.' },
  });
});

test('missing UI build returns an actionable service error without changing API auth', async (t) => {
  const uiDirectory = join(tmpdir(), `factory-ui-missing-${process.pid}-${Date.now()}`);
  const { request } = await fixture(t, uiDirectory);

  const page = await request('/');
  assert.equal(page.status, 503);
  assert.deepEqual(await page.json(), {
    error: {
      code: 'UI_NOT_BUILT',
      message: 'The dashboard is not built. Run npm run build.',
    },
  });
  assert.equal((await request('/v1/runs/missing')).status, 401);
});
