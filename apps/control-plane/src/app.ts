import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import type { Config } from './config.ts';
import type { Core } from './core.ts';
import { FactoryError, type Issue, type Run, type StageName } from './domain.ts';
import { handleError } from './http.ts';
import { handleMcp } from './mcp.ts';
import type { TerminalService } from './terminal.ts';
import { mountUi } from './ui.ts';
import { newRunSchema, parse, rejectSchema } from './validation.ts';

function authorized(actual: string | undefined, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const received = Buffer.from(actual ?? '');
  return expected.length === received.length && timingSafeEqual(expected, received);
}

/** What the HTTP layer needs from the rest of the factory. */
export interface Services {
  core: Core;
  config: Config;
  ready: () => boolean;
  /** Turns a pasted issue or ticket URL into an issue. */
  resolve(url: string): Promise<Issue>;
  submit(issue: Issue): Promise<Run>;
  retry(runId: string): Promise<Run>;
  cancel(runId: string): Promise<Run>;
  approve(runId: string): Promise<Run>;
  reject(runId: string, feedback: string): Promise<Run>;
  tail(runId: string): Promise<{ stage: StageName | null; text: string }>;
  poll(): Promise<Run[]>;
  terminal?: TerminalService;
  /** Names of the configured external task providers. */
  providers?: () => string[];
  intake(): { lastPollAt: string | null; lastError: string | null };
}

export function applications(services: Services, uiDirectory?: string) {
  const { core, config, ready } = services;
  const app = express();
  app.disable('x-powered-by');
  mountUi(app, uiDirectory);
  app.get('/healthz', (_req, res) => res.json({ alive: true }));
  app.get('/readyz', (_req, res) => {
    const available = ready();
    res.status(available ? 200 : 503).json({ ready: available });
  });
  app.use((req, _res, next) => {
    if (config.apiToken !== undefined && !authorized(req.get('authorization'), config.apiToken)) {
      next(new FactoryError('A valid bearer token is required.', 401, 'UNAUTHORIZED'));
      return;
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !ready()) {
      next(new FactoryError('The factory is not ready.', 503, 'NOT_READY'));
      return;
    }
    next();
  });
  app.use(express.json({ limit: '1mb' }));

  app.get('/v1/factory', (_req, res) =>
    res.json({
      repos: config.repos,
      label: config.label,
      autonomy: config.autonomy,
      pollSeconds: config.pollSeconds,
      maxRuns: config.maxRuns,
      herdrSession: config.herdrSession,
      providers: services.providers?.() ?? [],
      terminal: config.terminal,
      ...services.intake(),
    }),
  );
  app.post('/v1/poll', async (_req, res) => res.json({ started: await services.poll() }));
  app.post('/v1/terminal/tickets', (req, res) => {
    if (!services.terminal)
      throw new FactoryError(
        'The web terminal is disabled (FACTORY_TERMINAL=off).',
        404,
        'TERMINAL_OFF',
      );
    const runId = typeof req.body?.runId === 'string' ? req.body.runId : undefined;
    if (runId !== undefined) core.get(runId);
    res.status(201).json(services.terminal.issueTicket(runId));
  });
  app.get('/v1/runs', (_req, res) => res.json({ runs: core.list() }));
  app.post('/v1/runs', async (req, res) => {
    const { issueUrl } = parse(newRunSchema, req.body);
    res.status(202).json(await services.submit(await services.resolve(issueUrl)));
  });
  app.get('/v1/runs/:id', (req, res) => {
    res.set('Cache-Control', 'no-store').json(core.get(req.params.id));
  });
  app.get('/v1/runs/:id/tail', async (req, res) => {
    res.set('Cache-Control', 'no-store').json(await services.tail(req.params.id));
  });
  app.post('/v1/runs/:id/retry', async (req, res) => res.json(await services.retry(req.params.id)));
  app.post('/v1/runs/:id/cancel', async (req, res) =>
    res.json(await services.cancel(req.params.id)),
  );
  app.post('/v1/runs/:id/approve', async (req, res) =>
    res.json(await services.approve(req.params.id)),
  );
  app.post('/v1/runs/:id/reject', async (req, res) =>
    res.json(await services.reject(req.params.id, parse(rejectSchema, req.body).feedback)),
  );
  // Server-sent events: one `run` event per change, so the dashboard never has to poll.
  app.get('/v1/events', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write(': connected\n\n');
    const send = (run: Run) => {
      const { plan: _plan, attachments: _attachments, ...summary } = run;
      res.write(`event: run\ndata: ${JSON.stringify(summary)}\n\n`);
    };
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 20_000);
    core.on('change', send);
    req.once('close', () => {
      clearInterval(heartbeat);
      core.off('change', send);
    });
  });
  app.use((_req, _res, next) => next(new FactoryError('Route not found.', 404, 'ROUTE_NOT_FOUND')));
  app.use(handleError);

  const mcp = express();
  mcp.disable('x-powered-by');
  mcp.use(express.json({ limit: '1mb' }));
  mcp.post('/mcp', (req, res, next) => {
    void handleMcp(core, req, res, ready).catch(next);
  });
  mcp.post('/mcp/runs/:runId/stages/:stage', (req, res, next) => {
    void handleMcp(core, req, res, ready, {
      runId: req.params.runId,
      stage: req.params.stage,
    }).catch(next);
  });
  mcp.all(['/mcp', '/mcp/runs/:runId/stages/:stage'], (_req, res) => {
    res
      .set('Allow', 'POST')
      .status(405)
      .json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method not allowed.' } });
  });
  mcp.use((_req, _res, next) => next(new FactoryError('Route not found.', 404, 'ROUTE_NOT_FOUND')));
  mcp.use(handleError);
  return { app, mcp };
}
