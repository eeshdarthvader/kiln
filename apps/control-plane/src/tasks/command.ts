import { execFile } from 'node:child_process';
import type { Issue } from '../domain.ts';
import type { TaskProvider } from '../ports.ts';

export interface CommandOptions {
  name: string;
  /** Executable and leading arguments, run without a shell. */
  command: string[];
  repo: string;
  /** A regular expression whose first group captures the ticket key from a pasted URL. */
  urlPattern?: string;
  run?: (command: string[], args: string[], input?: string) => Promise<string>;
}

function execute(command: string[], args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command[0]!,
      [...command.slice(1), ...args],
      { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) =>
        error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout),
    );
    child.stdin?.end(input);
  });
}

interface Ticket {
  key: string;
  title: string;
  body?: string;
  url: string;
  labels?: string[];
  repo?: string;
  state?: 'open' | 'closed';
}

/**
 * Any tracker that can list tickets by label and add labels and comments, reached through a
 * small executable. It is called as `list <label>`, `get <key>`, `relabel <key> <add,...>
 * <remove,...>` and `comment <key>` (comment text on stdin); `list` and `get` print JSON
 * `{ key, title, body, url, labels, repo?, state? }` (an array for `list`).
 */
export class CommandProvider implements TaskProvider {
  readonly name: string;
  private readonly options: CommandOptions;
  private readonly run: NonNullable<CommandOptions['run']>;
  constructor(options: CommandOptions) {
    this.name = options.name;
    this.options = options;
    this.run = options.run ?? execute;
  }

  private issue(value: Ticket): Issue {
    if (typeof value.key !== 'string' || !/^[\w.:-]{1,64}$/.test(value.key))
      throw new Error(`Provider ${this.name} returned an invalid ticket key.`);
    return {
      repo: value.repo ?? this.options.repo,
      number: Number(/(\d+)$/.exec(value.key)?.[1] ?? 0),
      title: String(value.title ?? value.key),
      body: String(value.body ?? ''),
      url: String(value.url ?? ''),
      labels: value.labels ?? [],
      state: value.state === 'closed' ? 'closed' : 'open',
      ticket: { provider: this.name, key: value.key },
    };
  }

  async labelled(label: string): Promise<Issue[]> {
    const found = JSON.parse(await this.run(this.options.command, ['list', label])) as Ticket[];
    return found.map((value) => this.issue(value));
  }

  async get(key: string): Promise<Issue> {
    return this.issue(JSON.parse(await this.run(this.options.command, ['get', key])) as Ticket);
  }

  async relabel(key: string, add: string[], remove: string[]): Promise<void> {
    await this.run(this.options.command, ['relabel', key, add.join(','), remove.join(',')]);
  }

  async comment(key: string, body: string): Promise<void> {
    await this.run(this.options.command, ['comment', key], body);
  }

  parseUrl(url: string): string | null {
    if (!this.options.urlPattern) return null;
    return new RegExp(this.options.urlPattern).exec(url)?.[1] ?? null;
  }
}
