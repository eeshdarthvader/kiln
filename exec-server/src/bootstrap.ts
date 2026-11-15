import { once } from 'node:events';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { applications } from './app.ts';
import { configuration, type Config } from './config.ts';
import { Core } from './core.ts';
import { profiles, type Capability } from './domain.ts';
import { OpenCodeClient } from './opencode/client.ts';
import { TaskInitializer } from './setup.ts';
import { RuntimeCommandError } from './ports.ts';

export class StartupError extends Error {}

export async function probeReporting(url: string): Promise<void> {
  const client = new Client({ name: 'sawd-bootstrap', version: '0.1.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url)), { timeout: 10_000 });
    const result = await client.listTools({}, { timeout: 10_000 });
    if (!result.tools.some((tool) => tool.name === 'get_reporting_instructions'))
      throw new Error('Reporting tool get_reporting_instructions is unavailable.');
    const instructions = await client.callTool(
      { name: 'get_reporting_instructions', arguments: {} },
      undefined,
      { timeout: 10_000 },
    );
    if (instructions.isError) throw new Error('Reporting instructions probe failed.');
  } finally {
    await client.close();
  }
}

export async function start(config: Config = configuration()): Promise<() => Promise<void>> {
  const startup = new AbortController();
  let runtime: OpenCodeClient | undefined;
  const servers: Server[] = [];
  let ready = false;
  let stage = 'connecting to opencode and discovering models';
  let closing: Promise<void> | undefined;
  const close = () => {
    startup.abort();
    closing ??= (async () => {
      ready = false;
      runtime?.close();
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve) => {
              server.closeAllConnections();
              server.close(() => resolve());
            }),
        ),
      );
      process.off('SIGTERM', shutdown);
      process.off('SIGINT', shutdown);
    })();
    return closing;
  };
  const shutdown = () => {
    void close();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  try {
    runtime = new OpenCodeClient({
      url: config.opencodeUrl,
      password: config.opencodePassword,
      workspaceRoot: config.workspaceRoot,
    });
    const discovery = await runtime.discover();
    startup.signal.throwIfAborted();
    const capabilities: Capability[] = ['git', 'node', 'python'];
    if (config.startDocker) capabilities.push('docker');
    const supported = profiles(discovery.providers, discovery.taskWorkspaceRoot, capabilities);
    if (!supported.length)
      throw new StartupError('opencode has no available models supporting tool execution.');
    const core = new Core(supported);
    const initializer = new TaskInitializer(
      core,
      runtime,
      config.opencodePublicUrl ?? config.opencodeUrl,
    );
    const apps = applications(
      core,
      () => ready,
      config.apiToken,
      undefined,
      (taskId) => initializer.start(taskId),
      {
        url: config.opencodePublicUrl ?? config.opencodeUrl,
        password: config.opencodePassword,
      },
    );
    stage = `binding the reporting listener to 127.0.0.1:${config.mcpPort}`;
    const reporting = apps.mcp.listen(config.mcpPort, '127.0.0.1');
    servers.push(reporting);
    await once(reporting, 'listening', { signal: startup.signal });
    startup.signal.throwIfAborted();
    stage = 'registering reporting tools with opencode';
    await runtime.registerReporting(`http://127.0.0.1:${config.mcpPort}/mcp`);
    startup.signal.throwIfAborted();
    stage = 'probing reporting tool discovery';
    await probeReporting(`http://127.0.0.1:${config.mcpPort}/mcp`);
    startup.signal.throwIfAborted();
    stage = `binding the HTTP listener to 0.0.0.0:${config.port}`;
    const http = apps.app.listen(config.port, '0.0.0.0');
    servers.push(http);
    await once(http, 'listening', { signal: startup.signal });
    startup.signal.throwIfAborted();
    ready = true;
    console.log(`SAWD listening on 0.0.0.0:${config.port}`);
    return close;
  } catch (error) {
    const interrupted = startup.signal.aborted;
    await close();
    if (interrupted) return close;
    if (error instanceof StartupError) throw error;
    if (error instanceof RuntimeCommandError)
      throw new StartupError(`SAWD startup failed while ${stage}: ${error.message}`);
    throw new StartupError(`SAWD startup failed while ${stage}.`);
  }
}
