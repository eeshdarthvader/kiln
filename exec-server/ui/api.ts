export type Api = <T>(path: string, method?: 'GET' | 'PUT' | 'POST', body?: unknown) => Promise<T>;

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

export const taskPath = (id: string) => `/tasks/${encodeURIComponent(id)}`;
export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : 'The request failed. Try again.';
export const wasRejected = (error: unknown) =>
  error instanceof RequestError && [400, 404, 409, 422].includes(error.status);
