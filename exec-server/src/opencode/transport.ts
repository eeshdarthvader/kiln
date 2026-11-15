import { RuntimeCommandError, RuntimeNotFoundError } from '../ports.ts';

export class OpenCodeTransport {
  private readonly base: URL;
  private readonly authorization?: string;
  private readonly controllers = new Set<AbortController>();
  private closed = false;

  constructor(options: { url: string; password?: string }) {
    this.base = new URL(options.url);
    if (
      !['http:', 'https:'].includes(this.base.protocol) ||
      this.base.username ||
      this.base.password ||
      this.base.search ||
      this.base.hash
    )
      throw new Error(
        'OPENCODE_URL must be an HTTP(S) URL without credentials, query, or fragment.',
      );
    if (options.password)
      this.authorization = `Basic ${Buffer.from(`opencode:${options.password}`).toString('base64')}`;
  }

  async request(
    path: string,
    directory?: string,
    method = 'GET',
    body?: unknown,
    query: Record<string, string> = {},
  ): Promise<unknown> {
    if (this.closed) throw new Error('OpenCode connection is closed.');
    const url = new URL(path, this.base);
    if (directory !== undefined) url.searchParams.set('location[directory]', directory);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(url, {
        method,
        headers: {
          ...(this.authorization ? { authorization: this.authorization } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: controller.signal,
      });
      if (response.status === 404 && method === 'GET') throw new RuntimeNotFoundError();
      if (!response.ok)
        throw new RuntimeCommandError(
          `OpenCode request failed (HTTP ${response.status}).`,
          response.status >= 400 && response.status < 500 ? 'rejected' : 'unknown',
        );
      if (response.status === 204) return undefined;
      return await response.json();
    } catch (error) {
      if (error instanceof RuntimeCommandError || error instanceof RuntimeNotFoundError)
        throw error;
      throw new RuntimeCommandError(
        'OpenCode request result is unknown. Check the running server.',
        'unknown',
      );
    } finally {
      clearTimeout(timer);
      this.controllers.delete(controller);
    }
  }

  close(): void {
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
  }
}
