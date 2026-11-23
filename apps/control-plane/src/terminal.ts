import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { FactoryError } from './domain.ts';

const bridge = fileURLToPath(new URL('./terminal/pty-bridge.py', import.meta.url));
const ticketLifetimeMs = 30_000;
export const terminalPath = '/v1/terminal';

/** True for a Host/Origin value that names this machine, so other sites and rebinding fail. */
export function loopbackHost(value: string | undefined, origin = false): boolean {
  if (!value) return false;
  try {
    const url = new URL(origin ? value : `http://${value}`);
    return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

export interface TerminalOptions {
  shell: string;
  /** Directory used when a ticket names no run or the run has no worktree. */
  home: string;
  maxSessions?: number;
  /** Resolves the working directory of a run, or undefined if it has none. */
  worktree(runId: string): string | undefined;
}

/**
 * A shell on the host, reached over a WebSocket, for fixing things by hand while a run
 * works. Browsers cannot set headers on a WebSocket, so the dashboard first POSTs for a
 * one-time ticket (authorised like any other API call) and presents it on the upgrade.
 */
export class TerminalService {
  private readonly tickets = new Map<string, { cwd: string; expires: number }>();
  private readonly children = new Set<ChildProcess>();
  private readonly sockets = new WebSocketServer({ noServer: true });
  private readonly options: TerminalOptions;

  constructor(options: TerminalOptions) {
    this.options = options;
  }

  issueTicket(runId?: string): { ticket: string; cwd: string } {
    let cwd = this.options.home;
    if (runId !== undefined) {
      const worktree = this.options.worktree(runId);
      if (worktree && existsSync(worktree) && statSync(worktree).isDirectory()) cwd = worktree;
    }
    const now = Date.now();
    for (const [ticket, value] of this.tickets)
      if (value.expires <= now) this.tickets.delete(ticket);
    const ticket = randomBytes(24).toString('hex');
    this.tickets.set(ticket, { cwd, expires: now + ticketLifetimeMs });
    return { ticket, cwd };
  }

  private redeem(ticket: string | null): string | undefined {
    const value = ticket ? this.tickets.get(ticket) : undefined;
    if (ticket) this.tickets.delete(ticket);
    return value && value.expires > Date.now() ? value.cwd : undefined;
  }

  attach(server: Server): void {
    server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname !== terminalPath) {
        socket.destroy();
        return;
      }
      const refuse = (status: number, reason: string) => {
        socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
      };
      const origin = request.headers.origin;
      if (!loopbackHost(request.headers.host) || (origin && !loopbackHost(origin, true)))
        return refuse(403, 'Forbidden');
      const cwd = this.redeem(url.searchParams.get('ticket'));
      if (cwd === undefined) return refuse(401, 'Unauthorized');
      if (this.children.size >= (this.options.maxSessions ?? 4)) return refuse(429, 'Too Many');
      this.sockets.handleUpgrade(request, socket, head, (ws) => this.open(ws, cwd));
    });
  }

  private open(ws: WebSocket, cwd: string): void {
    const child = spawn('python3', ['-I', bridge, this.options.shell, cwd], {
      stdio: ['pipe', 'pipe', 'ignore', 'pipe'],
      env: { ...process.env, FACTORY_API_TOKEN: undefined, TERM: 'xterm-256color' },
    });
    this.children.add(child);
    const control = child.stdio[3] as NodeJS.WritableStream;
    child.stdout!.on('data', (data: Buffer) => ws.readyState === ws.OPEN && ws.send(data));
    child.stdin!.on('error', () => {});
    control.on('error', () => {});
    child.once('exit', () => {
      this.children.delete(child);
      if (ws.readyState === ws.OPEN) ws.close(1000, 'The shell exited.');
    });
    child.once('error', () => ws.close(1011, 'The terminal helper could not start.'));
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        child.stdin!.write(data as Buffer);
        return;
      }
      try {
        const message = JSON.parse(data.toString()) as {
          type?: string;
          cols?: unknown;
          rows?: unknown;
        };
        if (
          message.type === 'resize' &&
          Number.isInteger(message.cols) &&
          Number.isInteger(message.rows)
        )
          control.write(`${message.cols} ${message.rows}\n`);
      } catch {
        // Ignore malformed control frames.
      }
    });
    ws.once('close', () => {
      child.stdin!.end();
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    });
  }

  close(): void {
    for (const child of this.children) child.kill('SIGKILL');
    for (const ws of this.sockets.clients) ws.terminate();
  }
}

export function disabledTerminal(): never {
  throw new FactoryError(
    'The web terminal is disabled (FACTORY_TERMINAL=off).',
    404,
    'TERMINAL_OFF',
  );
}
