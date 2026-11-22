export type Api = <T>(path: string, method?: 'GET' | 'POST', body?: unknown) => Promise<T>;

export class RequestError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export function createApi(token: string): Api {
  return async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    const response = await fetch(`/v1${path}`, {
      method,
      cache: 'no-store',
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        data &&
        typeof data === 'object' &&
        'error' in data &&
        data.error &&
        typeof data.error === 'object' &&
        'message' in data.error
          ? String(data.error.message)
          : `Request failed (${response.status}).`;
      throw new RequestError(
        response.status === 401 || response.status === 403
          ? 'Authorization failed. Enter a valid API token using “API access”, then retry.'
          : message,
        response.status,
      );
    }
    if (data === null)
      throw new Error('The server returned an invalid response. Retry the request.');
    return data as T;
  };
}

export const runPath = (id: string) => `/runs/${encodeURIComponent(id)}`;

/**
 * Follows the server's event stream. `fetch` is used instead of EventSource so the API token
 * travels in a header, never in the URL. Reconnects until the returned function is called.
 */
export function subscribe(
  token: string,
  onRun: (run: unknown) => void,
  onState: (connected: boolean) => void,
): () => void {
  const controller = new AbortController();
  void (async () => {
    while (!controller.signal.aborted) {
      try {
        const response = await fetch('/v1/events', {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          signal: controller.signal,
        });
        if (!response.ok || !response.body) throw new Error(`events ${response.status}`);
        onState(true);
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const data = block
              .split('\n')
              .filter((line) => line.startsWith('data: '))
              .map((line) => line.slice(6))
              .join('\n');
            if (block.startsWith('event: run') && data) onRun(JSON.parse(data));
          }
        }
      } catch {
        // Fall through to the retry below.
      }
      if (controller.signal.aborted) return;
      onState(false);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  })();
  return () => controller.abort();
}
export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : 'The request failed. Try again.';
export const wasRejected = (error: unknown) =>
  error instanceof RequestError && [400, 404, 409, 422].includes(error.status);
