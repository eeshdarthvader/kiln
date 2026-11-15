import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import type { Core } from './core.ts';
import { SawdError, type Task } from './domain.ts';
import { handleError } from './http.ts';
import { handleMcp } from './mcp.ts';
import { openApiDocument } from './openapi.ts';
import { mountUi } from './ui.ts';
import type { OpenCodeConnection } from './shared/types.ts';

function authorized(actual: string | undefined, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const received = Buffer.from(actual ?? '');
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export function applications(
  core: Core,
  ready: () => boolean,
  apiToken?: string,
  uiDirectory?: string,
  startTask?: (id: string) => Promise<Task>,
  opencodeConnection?: OpenCodeConnection,
) {
  const app = express();
  app.disable('x-powered-by');
  mountUi(app, uiDirectory);
  app.get('/healthz', (_req, res) => res.json({ alive: true }));
  app.get('/readyz', (_req, res) => {
    const available = ready();
    res.status(available ? 200 : 503).json({ ready: available });
  });
  app.use((req, res, next) => {
    if (apiToken !== undefined && !authorized(req.get('authorization'), apiToken)) {
      next(new SawdError('A valid bearer token is required.', 401, 'UNAUTHORIZED'));
      return;
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !ready()) {
      next(new SawdError('SAWD is not ready.', 503, 'NOT_READY'));
      return;
    }
    next();
  });
  app.use(express.json({ limit: '1mb' }));
  app.get('/v1/openapi.json', (_req, res) => res.json(openApiDocument));
  app.get('/v1/agents', (_req, res) => res.json({ schemaVersion: 1, agents: core.listAgents() }));
  app.get('/v1/opencode/connection', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!opencodeConnection)
      throw new SawdError('OpenCode login details are unavailable.', 503, 'NOT_READY');
    res.json(opencodeConnection);
  });
  app.put('/v1/tasks/:id', (req, res) => {
    const result = core.accept(req.params.id, req.body);
    res.status(result.created ? 201 : 200).json(result.task);
  });
  app.get('/v1/tasks', (_req, res) => res.json({ tasks: core.list() }));
  app.get('/v1/tasks/:id', (req, res) => {
    res.set('Cache-Control', 'no-store').json(core.get(req.params.id));
  });
  app.post('/v1/tasks/:id/start', async (req, res) => {
    core.record(req.params.id);
    if (!startTask) throw new SawdError('Task setup is unavailable.', 503, 'NOT_READY');
    res.json(await startTask(req.params.id));
  });
  app.post('/v1/tasks/:id/archive', (req, res) => res.json(core.archive(req.params.id)));
  app.use((_req, _res, next) => next(new SawdError('Route not found.', 404, 'ROUTE_NOT_FOUND')));
  app.use(handleError);

  const mcp = express();
  mcp.disable('x-powered-by');
  mcp.use(express.json({ limit: '1mb' }));
  mcp.post('/mcp', (req, res, next) => {
    void handleMcp(core, req, res, ready).catch(next);
  });
  mcp.post('/mcp/tasks/:taskId', (req, res, next) => {
    void handleMcp(core, req, res, ready, req.params.taskId).catch(next);
  });
  mcp.all(['/mcp', '/mcp/tasks/:taskId'], (_req, res) => {
    res
      .set('Allow', 'POST')
      .status(405)
      .json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32000, message: 'Method not allowed.' },
      });
  });
  mcp.use((_req, _res, next) => next(new SawdError('Route not found.', 404, 'ROUTE_NOT_FOUND')));
  mcp.use(handleError);
  return { app, mcp };
}
