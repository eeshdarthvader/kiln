import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configuration } from './config.ts';

const credentials = { OPENCODE_PASSWORD: 'test-password' };

test('configuration defaults keep MCP private and expose fixed listener ports', () => {
  assert.deepEqual(configuration(credentials), {
    port: 3775,
    mcpPort: 3776,
    opencodeUrl: 'http://127.0.0.1:3773',
    opencodePassword: 'test-password',
    workspaceRoot: '/workspace/sawd',
    startDocker: false,
  });
  assert.equal(configuration({ ...credentials, SAWD_START_DOCKER: 'true' }).startDocker, true);
  assert.equal(configuration({ ...credentials, SAWD_START_DOCKER: 'false' }).startDocker, false);
  assert.equal(
    configuration({ ...credentials, SAWD_API_TOKEN: 'local-secret' }).apiToken,
    'local-secret',
  );
});

test('configuration rejects malformed ports, booleans, credentials and endpoints', () => {
  for (const name of ['SAWD_PORT', 'SAWD_MCP_PORT'])
    for (const value of ['0', '65536', '1.2', '', ' 3775', '1e3', 'abc'])
      assert.throws(() => configuration({ ...credentials, [name]: value }), new RegExp(name));
  assert.throws(() => configuration({ ...credentials, SAWD_PORT: '3776' }), /must differ/);
  for (const value of ['', '1', 'TRUE', 'yes'])
    assert.throws(
      () => configuration({ ...credentials, SAWD_START_DOCKER: value }),
      /SAWD_START_DOCKER/,
    );
  for (const value of ['', 'has space', 'line\nbreak'])
    assert.throws(() => configuration({ ...credentials, SAWD_API_TOKEN: value }), /SAWD_API_TOKEN/);
  for (const value of [
    'not a url',
    'file:///tmp',
    'http://user:secret@localhost',
    'http://localhost/?secret=value',
    'http://localhost/#token',
  ])
    for (const name of ['OPENCODE_URL', 'OPENCODE_PUBLIC_URL'])
      assert.throws(() => configuration({ ...credentials, [name]: value }), new RegExp(name));
});

test('browser runtime URL can differ from the private connection URL', () => {
  const config = configuration({
    ...credentials,
    OPENCODE_URL: 'http://opencode:3773',
    OPENCODE_PUBLIC_URL: 'https://runtime.example/opencode/',
  });
  assert.equal(config.opencodeUrl, 'http://opencode:3773');
  assert.equal(config.opencodePublicUrl, 'https://runtime.example/opencode');
});

test('configuration validates the shared workspace', () => {
  assert.equal(
    configuration({ ...credentials, SAWD_WORKSPACE_ROOT: '/tmp/tasks' }).workspaceRoot,
    '/tmp/tasks',
  );
  for (const value of ['', 'relative', '/tmp/line\nbreak'])
    assert.throws(
      () => configuration({ ...credentials, SAWD_WORKSPACE_ROOT: value }),
      /SAWD_WORKSPACE_ROOT/,
    );
});

test('configuration requires supplied runtime credentials with the fixed v2 username', () => {
  assert.throws(() => configuration({}), /OPENCODE_PASSWORD/);
  const config = configuration({
    OPENCODE_SERVER_USERNAME: 'opencode',
    OPENCODE_SERVER_PASSWORD: 'secret:with spaces',
  });
  assert.equal('opencodeUsername' in config, false);
  assert.equal(config.opencodePassword, 'secret:with spaces');
  for (const name of ['OPENCODE_PASSWORD', 'OPENCODE_SERVER_PASSWORD'])
    for (const value of ['', 'line\nbreak', 'control\x7f'])
      assert.throws(() => configuration({ [name]: value }), new RegExp(name));
  for (const value of ['', 'custom', 'user:name', 'line\nbreak'])
    assert.throws(
      () => configuration({ ...credentials, OPENCODE_SERVER_USERNAME: value }),
      /OPENCODE_SERVER_USERNAME/,
    );
});

test('the native password overrides the legacy alias without falling back from an empty value', () => {
  assert.equal(
    configuration({ ...credentials, OPENCODE_SERVER_PASSWORD: 'legacy' }).opencodePassword,
    'test-password',
  );
  assert.throws(
    () => configuration({ OPENCODE_PASSWORD: '', OPENCODE_SERVER_PASSWORD: 'legacy' }),
    /OPENCODE_PASSWORD/,
  );
});
