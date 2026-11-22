import type { Change } from '../domain.ts';
import type { Repository } from '../ports.ts';
import { execute, type Execute } from './gh.ts';

/** Reads a worktree with plain `git`, on the host. */
export class GitRepository implements Repository {
  private readonly run: Execute;
  constructor(run: Execute = execute) {
    this.run = run;
  }

  async readFile(worktree: string, ref: string, path: string): Promise<string | null> {
    try {
      return await this.run('git', ['-C', worktree, 'show', `${ref}:${path}`]);
    } catch (error) {
      // `git show` fails the same way for a missing file and a missing ref; only the former is
      // an ordinary answer.
      if (/does not exist|exists on disk, but not in/.test((error as Error).message)) return null;
      throw error;
    }
  }

  async changes(worktree: string, base: string): Promise<Change[]> {
    const output = await this.run('git', [
      '-C',
      worktree,
      'diff',
      '--numstat',
      '--no-renames',
      '-z',
      `${base}...HEAD`,
    ]);
    return output
      .split('\0')
      .filter(Boolean)
      .flatMap((entry) => {
        const [added, deleted, ...rest] = entry.split('\t');
        const path = rest.join('\t');
        // Binary files report "-"; they still count as a changed file.
        return path ? [{ path, added: Number(added) || 0, deleted: Number(deleted) || 0 }] : [];
      });
  }
}
