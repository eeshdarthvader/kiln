import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { applications } from './app.ts';
import { configuration, type Config } from './config.ts';
import { ChangesService } from './changes.ts';
import { Core } from './core.ts';
import { GhCli } from './github/gh.ts';
import { GitRepository } from './github/git.ts';
import { Intake } from './github/intake.ts';
import { PullRequestWatcher } from './github/pulls.ts';
import { HerdrClient, HerdrRuntime, TerminalService } from '@factory/runtime';
import { Pipeline } from './pipeline.ts';
import { loadProviders } from './tasks/providers.ts';
import { parseIssueUrl } from './validation.ts';
import { FileRunStore } from './store.ts';

export class StartupError extends Error {}

/**
 * Writes the credentials file handed to agent containers with `--env-file`. Values come only
 * from this process's environment (or `gh auth token`), and the file is readable by its owner.
 */
export async function writeAgentEnvironment(
  config: Config,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const values: Record<string, string> = {};
  for (const name of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'GH_TOKEN'])
    if (env[name]) values[name] = env[name];
  if (!values.GH_TOKEN) {
    try {
      const { stdout } = await promisify(execFile)('gh', ['auth', 'token']);
      if (stdout.trim()) values.GH_TOKEN = stdout.trim();
    } catch {
      // Reported below as a missing credential.
    }
  }
  const path = join(config.home, 'agent.env');
  await writeFile(
    path,
    Object.entries(values)
      .map(([name, value]) => `${name}=${value}\n`)
      .join(''),
    {
      mode: 0o600,
    },
  );
  await chmod(path, 0o600);
  const missing: string[] = [];
  if (!values.GH_TOKEN) missing.push('GH_TOKEN (or a `gh auth login` session)');
  if (!values.CLAUDE_CODE_OAUTH_TOKEN && !values.ANTHROPIC_API_KEY)
    missing.push('CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) or ANTHROPIC_API_KEY');
  return missing;
}

export async function start(config: Config = configuration()): Promise<() => Promise<void>> {
  const servers: Server[] = [];
  let ready = false;
  let stage = 'preparing the factory home';
  let closing: Promise<void> | undefined;
  let runtime: HerdrRuntime | undefined;
  let pipeline: Pipeline | undefined;
  let intake: Intake | undefined;
  let pulls: PullRequestWatcher | undefined;
  let terminal: TerminalService | undefined;
  const close = () => {
    closing ??= (async () => {
      ready = false;
      intake?.stop();
      pulls?.stop();
      pipeline?.stop();
      terminal?.close();
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
  const shutdown = () => void close();
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  try {
    await mkdir(config.home, { recursive: true, mode: 0o700 });
    const missing = config.agentCommand ? [] : await writeAgentEnvironment(config, process.env);
    for (const item of missing) console.warn(`Agents will not be able to work without ${item}.`);

    stage = `connecting to the Herdr session "${config.herdrSession}" at ${config.herdrSocket}`;
    runtime = new HerdrRuntime(new HerdrClient(config.herdrSocket), config);
    await runtime.connect();

    stage = 'loading runs';
    const core = new Core(new FileRunStore(join(config.home, 'runs')));
    const github = new GhCli(join(config.home, 'repos'));
    stage = 'loading task providers';
    const providers = loadProviders(config);
    const repository = new GitRepository();
    pipeline = new Pipeline(core, runtime, github, config, {
      repository,
      providers: new Map(providers.map((provider) => [provider.name, provider])),
    });
    const engine = pipeline;
    const changes = new ChangesService(core, github, repository);
    intake = new Intake(core, github, config, (issue) => engine.submit(issue), providers);
    const poller = intake;
    pulls = new PullRequestWatcher(
      core,
      github,
      config,
      (runId) => void engine.resolveConflicts(runId),
    );
    const watcher = pulls;
    if (config.terminal)
      terminal = new TerminalService({
        shell: config.terminalShell,
        home: config.home,
        worktree: (runId) => core.get(runId).worktreePath ?? undefined,
      });
    const apps = applications({
      core,
      ...(terminal ? { terminal } : {}),
      config,
      ready: () => ready,
      providers: () => providers.map((provider) => provider.name),
      resolve: async (url) => {
        for (const provider of providers) {
          const key = provider.parseUrl(url.trim());
          if (key) return provider.get(key);
        }
        const { repo, number } = parseIssueUrl(url);
        return github.issue(repo, number);
      },
      submit: (issue) => engine.submit(issue),
      retry: (runId) => engine.retry(runId),
      cancel: (runId) => engine.cancel(runId),
      approve: (runId) => engine.approve(runId),
      reject: (runId, feedback) => engine.reject(runId, feedback),
      tail: (runId) => engine.tail(runId),
      changes: (runId) => changes.changes(runId),
      overlaps: () => changes.overlaps(),
      poll: async () => {
        await watcher.check();
        return poller.poll();
      },
      intake: () => ({ lastPollAt: poller.lastPollAt, lastError: poller.lastError }),
    });

    stage = `binding the reporting listener to ${config.mcpHost}:${config.mcpPort}`;
    const reporting = apps.mcp.listen(config.mcpPort, config.mcpHost);
    servers.push(reporting);
    await once(reporting, 'listening');

    stage = `binding the HTTP listener to 127.0.0.1:${config.port}`;
    const http = apps.app.listen(config.port, '127.0.0.1');
    servers.push(http);
    terminal?.attach(http);
    await once(http, 'listening');

    ready = true;
    stage = 'resuming runs';
    await pipeline.start();
    intake.start();
    pulls.start();
    console.log(`Factory dashboard: http://127.0.0.1:${config.port}`);
    if (providers.length)
      console.log(`Watching task providers: ${providers.map((item) => item.name).join(', ')}.`);
    console.log(
      config.repos.length
        ? `Watching ${config.repos.join(', ')} for the "${config.label}" label every ${config.pollSeconds}s.`
        : 'No repositories are watched (FACTORY_REPOS is empty); add issues from the dashboard.',
    );
    return close;
  } catch (error) {
    await close();
    throw new StartupError(`Factory startup failed while ${stage}: ${(error as Error).message}`);
  }
}
