import { mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { RuntimeCommandError } from '../ports.ts';

export async function provisionDirectory(workspaceRoot: string, path: string): Promise<string> {
  const directory = resolve(path);
  const suffix = relative(workspaceRoot, directory);
  if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix))
    throw new RuntimeCommandError(
      'The task directory must be inside the OpenCode workspace root.',
      'rejected',
    );
  await mkdir(directory, { recursive: true });
  const [actualRoot, actualDirectory] = await Promise.all([
    realpath(workspaceRoot),
    realpath(directory),
  ]);
  const actualSuffix = relative(actualRoot, actualDirectory);
  if (
    !actualSuffix ||
    actualSuffix === '..' ||
    actualSuffix.startsWith(`..${sep}`) ||
    isAbsolute(actualSuffix)
  )
    throw new RuntimeCommandError(
      'The task directory escapes the OpenCode workspace root.',
      'rejected',
    );
  return actualDirectory;
}
