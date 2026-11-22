import type { Config } from '../config.ts';
import type { Core } from '../core.ts';
import type { Issue, Run } from '../domain.ts';
import type { GitHub } from '../ports.ts';

/** Finds issues carrying the factory label and hands them to the pipeline. */
export class Intake {
  private timer: NodeJS.Timeout | undefined;
  private polling = false;
  lastPollAt: string | null = null;
  lastError: string | null = null;
  private readonly core: Core;
  private readonly github: GitHub;
  private readonly config: Config;
  private readonly submit: (issue: Issue) => Promise<Run>;
  constructor(core: Core, github: GitHub, config: Config, submit: (issue: Issue) => Promise<Run>) {
    this.core = core;
    this.github = github;
    this.config = config;
    this.submit = submit;
  }

  start(): void {
    if (!this.config.repos.length || this.config.pollSeconds === 0) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.config.pollSeconds * 1000);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /** One pass over every watched repository. Returns the runs it started or restarted. */
  async poll(): Promise<Run[]> {
    if (this.polling) return [];
    this.polling = true;
    const started: Run[] = [];
    const errors: string[] = [];
    try {
      for (const repo of this.config.repos) {
        try {
          for (const issue of await this.github.labelledIssues(repo, this.config.label)) {
            // The label is removed when a run starts, so finding it again on an issue whose
            // run stopped means someone asked for another attempt.
            const existing = this.core.findByIssue(issue.repo, issue.number);
            if (existing && ['queued', 'running', 'done'].includes(existing.status)) continue;
            started.push(await this.submit(issue));
          }
        } catch (error) {
          errors.push(`${repo}: ${(error as Error).message}`);
        }
      }
    } finally {
      this.polling = false;
      this.lastPollAt = new Date().toISOString();
      this.lastError = errors.length ? errors.join('; ') : null;
      if (errors.length) console.error(`Issue poll failed: ${this.lastError}`);
    }
    return started;
  }
}
