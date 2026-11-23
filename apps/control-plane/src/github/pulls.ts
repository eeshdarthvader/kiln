import type { Config } from '../config.ts';
import type { Core } from '../core.ts';
import type { GitHub } from '../ports.ts';

/**
 * Keeps each finished run's pull request state current, so the dashboard shows a merge or a
 * close whoever did it: the factory, a person, or auto-merge once checks passed.
 */
export class PullRequestWatcher {
  private timer: NodeJS.Timeout | undefined;
  private checking = false;
  private readonly core: Core;
  private readonly github: GitHub;
  private readonly config: Config;
  private readonly onConflict: ((runId: string) => void) | undefined;
  constructor(core: Core, github: GitHub, config: Config, onConflict?: (runId: string) => void) {
    this.core = core;
    this.github = github;
    this.config = config;
    this.onConflict = onConflict;
  }

  start(): void {
    if (this.config.pollSeconds === 0) return;
    void this.check();
    this.timer = setInterval(() => void this.check(), this.config.pollSeconds * 1000);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /** Looks up every run whose pull request is not yet merged or closed. Returns how many changed. */
  async check(): Promise<number> {
    if (this.checking) return 0;
    this.checking = true;
    let changed = 0;
    try {
      for (const run of this.core.list()) {
        if (!run.prUrl || run.prState === 'merged' || run.prState === 'closed') continue;
        try {
          const state = await this.github.pullRequestState(run.prUrl);
          if (state !== run.prState) {
            this.core.update(run.id, (draft) => {
              draft.prState = state;
            });
            changed += 1;
          }
          // Another run may have merged first and left this pull request unmergeable.
          if (
            this.onConflict &&
            run.status === 'done' &&
            (state === 'draft' || state === 'open') &&
            (await this.github.hasConflicts(run.prUrl))
          )
            this.onConflict(run.id);
        } catch (error) {
          console.error(`Could not check ${run.prUrl}: ${(error as Error).message}`);
        }
      }
    } finally {
      this.checking = false;
    }
    return changed;
  }
}
