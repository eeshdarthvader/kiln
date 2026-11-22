import { mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { FactoryError } from './domain.ts';

const escapes = (suffix: string) =>
  !suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix);

/** Creates `path` and returns its real path, refusing anything outside `root` (symlinks included). */
export async function provisionDirectory(root: string, path: string): Promise<string> {
  const directory = resolve(path);
  if (escapes(relative(root, directory)))
    throw new FactoryError('The directory must be inside the factory home.', 500);
  await mkdir(directory, { recursive: true });
  const [actualRoot, actualDirectory] = await Promise.all([realpath(root), realpath(directory)]);
  if (escapes(relative(actualRoot, actualDirectory)))
    throw new FactoryError('The directory escapes the factory home.', 500);
  return actualDirectory;
}
