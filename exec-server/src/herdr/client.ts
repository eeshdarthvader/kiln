import net from 'node:net';

export class HerdrError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'HerdrError';
    this.code = code;
  }
}

export interface HerdrEvent {
  event: string;
  data: Record<string, unknown>;
}

interface Envelope {
  id?: string;
  result?: Record<string, unknown>;
  error?: { code?: string; message?: string };
  event?: string;
  data?: Record<string, unknown>;
}

/**
 * Herdr's socket API: one JSON object per line over a Unix socket.
 * Requests use a short-lived connection each; a subscription keeps one open and reconnects.
 */
export class HerdrClient {
  private readonly socketPath: string;
  private readonly timeoutMs: number;
  private counter = 0;
  constructor(socketPath: string, timeoutMs = 20_000) {
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
  }

  call<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = `factory_${process.pid}_${++this.counter}`;
      const socket = net.createConnection(this.socketPath);
      let buffer = '';
      let settled = false;
      const settle = (action: () => void) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        action();
      };
      socket.setTimeout(this.timeoutMs, () =>
        settle(() => reject(new HerdrError('timeout', `Herdr did not answer ${method}.`))),
      );
      socket.on('connect', () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
      socket.on('data', (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        let message: Envelope;
        try {
          message = JSON.parse(buffer.slice(0, newline)) as Envelope;
        } catch {
          settle(() =>
            reject(new HerdrError('protocol', `Herdr sent invalid JSON for ${method}.`)),
          );
          return;
        }
        if (message.error)
          settle(() =>
            reject(
              new HerdrError(
                message.error?.code ?? 'error',
                `${method}: ${message.error?.message ?? 'Herdr reported an error.'}`,
              ),
            ),
          );
        else settle(() => resolve((message.result ?? {}) as T));
      });
      socket.on('error', (error) =>
        settle(() =>
          reject(
            new HerdrError(
              'unreachable',
              `Cannot reach Herdr at ${this.socketPath}: ${error.message}`,
            ),
          ),
        ),
      );
      socket.on('close', () =>
        settle(() =>
          reject(new HerdrError('closed', `Herdr closed the connection during ${method}.`)),
        ),
      );
    });
  }

  /**
   * Streams events until the returned function is called. A dropped connection (or Herdr
   * reporting lost events) reconnects and calls `onGap` so the caller can recheck state.
   */
  subscribe(
    subscriptions: Array<Record<string, unknown>>,
    onEvent: (event: HerdrEvent) => void,
    onGap: () => void = () => {},
  ): () => void {
    let stopped = false;
    let socket: net.Socket | undefined;
    let retry: NodeJS.Timeout | undefined;
    let first = true;
    const connect = () => {
      if (stopped) return;
      let buffer = '';
      socket = net.createConnection(this.socketPath);
      socket.on('connect', () => {
        socket?.write(
          `${JSON.stringify({ id: 'factory_events', method: 'events.subscribe', params: { subscriptions } })}\n`,
        );
        if (!first) onGap();
        first = false;
      });
      socket.on('data', (chunk) => {
        buffer += chunk;
        for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          let message: Envelope;
          try {
            message = JSON.parse(line) as Envelope;
          } catch {
            continue;
          }
          if (message.event) onEvent({ event: message.event, data: message.data ?? {} });
          else if (message.error) socket?.destroy();
        }
      });
      socket.on('error', () => {});
      socket.on('close', () => {
        if (stopped) return;
        retry = setTimeout(connect, 2000);
        retry.unref();
      });
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      socket?.destroy();
    };
  }
}
