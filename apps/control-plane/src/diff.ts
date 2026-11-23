export interface FileChange {
  path: string;
  oldPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  binary: boolean;
  /** Hunks only, starting at the first `@@`. Empty for binary files. */
  patch: string;
  /** True when the patch was cut to keep the response small. */
  truncated: boolean;
}

const maxFiles = 300;
const maxPatch = 60_000;

/** Splits `git diff` / `gh pr diff` output into one entry per file. */
export function parseDiff(text: string): { files: FileChange[]; truncated: boolean } {
  const blocks = text.split(/^diff --git /m).slice(1);
  const files = blocks.slice(0, maxFiles).map((block): FileChange => {
    const lines = block.split('\n');
    const header = /^a\/(.+?) b\/(.+)$/.exec(lines[0] ?? '');
    let oldPath = header?.[1] ?? '';
    let path = header?.[2] ?? oldPath;
    let status: FileChange['status'] = 'modified';
    let binary = false;
    let start = lines.findIndex((line) => line.startsWith('@@'));
    const preamble = start < 0 ? lines : lines.slice(0, start);
    for (const line of preamble) {
      if (line.startsWith('new file mode')) status = 'added';
      else if (line.startsWith('deleted file mode')) status = 'deleted';
      else if (line.startsWith('rename from ')) {
        status = 'renamed';
        oldPath = line.slice(12);
      } else if (line.startsWith('rename to ')) path = line.slice(10);
      else if (line.startsWith('Binary files') || line.startsWith('GIT binary patch'))
        binary = true;
    }
    if (start < 0) start = lines.length;
    const body = lines.slice(start);
    let additions = 0;
    let deletions = 0;
    for (const line of body) {
      if (line.startsWith('+')) additions++;
      else if (line.startsWith('-')) deletions++;
    }
    let patch = body.join('\n').trimEnd();
    const truncated = patch.length > maxPatch;
    if (truncated) patch = patch.slice(0, maxPatch);
    return {
      path,
      ...(status === 'renamed' ? { oldPath } : {}),
      status,
      additions,
      deletions,
      binary,
      patch: binary ? '' : patch,
      truncated,
    };
  });
  return { files, truncated: blocks.length > maxFiles };
}
