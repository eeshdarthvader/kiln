import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configuration } from './config.ts';

test('defaults suit a local install', () => {
  const config = configuration({ HOME: '/home/someone' });
  assert.equal(config.port, 3775);
  assert.equal(config.mcpPort, 3776);
  assert.equal(config.mcpPublicUrl, 'http://host.docker.internal:3776');
  assert.deepEqual(config.repos, []);
  assert.equal(config.label, 'factory');
  assert.equal(config.maxRuns, 2);
  assert.equal(config.herdrSession, 'factory');
  assert.match(config.herdrSocket, /\.config\/herdr\/sessions\/factory\/herdr\.sock$/);
  assert.match(config.home, /\.factory$/);
});

test('environment values are parsed and validated', () => {
  const config = configuration({
    FACTORY_REPOS: ' acme/widgets, acme/gadgets.js ,',
    FACTORY_LABEL: 'robot',
    FACTORY_HOME: '/srv/factory',
    FACTORY_MAX_RUNS: '4',
    HERDR_SESSION: 'ci',
    FACTORY_MCP_PUBLIC_URL: 'http://192.168.5.2:3776/',
    FACTORY_AGENT_COMMAND: 'node stub.mjs',
  });
  assert.deepEqual(config.repos, ['acme/widgets', 'acme/gadgets.js']);
  assert.equal(config.mcpPublicUrl, 'http://192.168.5.2:3776');
  assert.equal(config.agentCommand, 'node stub.mjs');
  assert.match(config.herdrSocket, /sessions\/ci\/herdr\.sock$/);

  for (const [env, message] of [
    [{ FACTORY_PORT: '0' }, /FACTORY_PORT/],
    [{ FACTORY_PORT: '4000', FACTORY_MCP_PORT: '4000' }, /must differ/],
    [{ FACTORY_REPOS: 'not-a-repo' }, /owner\/name/],
    [{ FACTORY_REPOS: 'acme/widgets;rm -rf' }, /owner\/name/],
    [{ FACTORY_LABEL: 'has space' }, /FACTORY_LABEL/],
    [{ FACTORY_HOME: 'relative/path' }, /FACTORY_HOME/],
    [{ FACTORY_API_TOKEN: 'has space' }, /FACTORY_API_TOKEN/],
    [{ HERDR_SESSION: '../default' }, /HERDR_SESSION/],
    [{ FACTORY_MCP_PUBLIC_URL: 'ftp://host' }, /FACTORY_MCP_PUBLIC_URL/],
    [{ FACTORY_MAX_RUNS: 'two' }, /FACTORY_MAX_RUNS/],
  ] as const)
    assert.throws(() => configuration(env), message);
});
