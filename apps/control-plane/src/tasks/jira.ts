import type { Issue } from '../domain.ts';
import type { TaskProvider } from '../ports.ts';

export interface JiraOptions {
  name: string;
  baseUrl: string;
  email: string;
  token: string;
  /** The GitHub repository that tickets without a more specific mapping are built in. */
  repo: string;
  /** Jira project key to GitHub repository. */
  repos?: Record<string, string>;
  /** Extra JQL ANDed onto the label search, for example `project = PROJ`. */
  jql?: string;
  fetch?: typeof fetch;
}

const keyPattern = /^[A-Z][A-Z0-9_]*-\d+$/;
const fields = 'summary,description,labels,project,status';

interface JiraIssue {
  key: string;
  fields: {
    summary?: string;
    description?: string | null;
    labels?: string[];
    project?: { key?: string };
    status?: { statusCategory?: { key?: string } };
  };
}

/** Jira Cloud over REST v2 (plain-text bodies). Works for any project that supports labels. */
export class JiraProvider implements TaskProvider {
  readonly name: string;
  private readonly options: JiraOptions;
  private readonly request: typeof fetch;
  constructor(options: JiraOptions) {
    this.name = options.name;
    this.options = { ...options, baseUrl: options.baseUrl.replace(/\/$/, '') };
    this.request = options.fetch ?? fetch;
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T | null> {
    const { email, token, baseUrl } = this.options;
    const response = await this.request(`${baseUrl}/rest/api/2${path}`, {
      ...init,
      headers: {
        Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`,
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok)
      throw new Error(
        `Jira ${init.method ?? 'GET'} ${path.split('?')[0]} failed (${response.status}).`,
      );
    return response.status === 204 ? null : ((await response.json()) as T);
  }

  private issue(value: JiraIssue): Issue {
    const project = value.fields.project?.key ?? value.key.split('-')[0]!;
    return {
      repo: this.options.repos?.[project] ?? this.options.repo,
      number: Number(value.key.split('-').pop()),
      title: value.fields.summary ?? value.key,
      body: value.fields.description ?? '',
      url: `${this.options.baseUrl}/browse/${value.key}`,
      labels: value.fields.labels ?? [],
      state: value.fields.status?.statusCategory?.key === 'done' ? 'closed' : 'open',
      ticket: { provider: this.name, key: value.key },
    };
  }

  async labelled(label: string): Promise<Issue[]> {
    const extra = this.options.jql ? ` AND (${this.options.jql})` : '';
    const jql = `labels = "${label.replaceAll('"', '')}" AND statusCategory != Done${extra} ORDER BY created ASC`;
    const found = await this.call<{ issues: JiraIssue[] }>(
      `/search/jql?${new URLSearchParams({ jql, fields, maxResults: '50' })}`,
    );
    return (found?.issues ?? []).map((value) => this.issue(value));
  }

  async get(key: string): Promise<Issue> {
    if (!keyPattern.test(key)) throw new Error(`"${key}" is not a Jira issue key.`);
    return this.issue((await this.call<JiraIssue>(`/issue/${key}?fields=${fields}`))!);
  }

  async relabel(key: string, add: string[], remove: string[]): Promise<void> {
    if (!add.length && !remove.length) return;
    await this.call(`/issue/${key}`, {
      method: 'PUT',
      body: JSON.stringify({
        update: {
          labels: [
            ...remove.map((name) => ({ remove: name })),
            ...add.map((name) => ({ add: name })),
          ],
        },
      }),
    });
  }

  async comment(key: string, body: string): Promise<void> {
    await this.call(`/issue/${key}/comment`, { method: 'POST', body: JSON.stringify({ body }) });
  }

  parseUrl(url: string): string | null {
    const prefix = `${this.options.baseUrl}/browse/`;
    if (!url.startsWith(prefix)) return null;
    const key = url.slice(prefix.length).split(/[?#/]/)[0] ?? '';
    return keyPattern.test(key) ? key : null;
  }
}
