import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDiff } from './diff.ts';

const diff = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1..2 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,3 @@',
  ' keep',
  '-old',
  '+new',
  '+more',
  'diff --git a/docs/new.md b/docs/new.md',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/docs/new.md',
  '@@ -0,0 +1 @@',
  '+hello',
  'diff --git a/old.txt b/gone.txt',
  'similarity index 100%',
  'rename from old.txt',
  'rename to gone.txt',
  'diff --git a/logo.png b/logo.png',
  'Binary files a/logo.png and b/logo.png differ',
  '',
].join('\n');

test('a unified diff becomes one entry per file with counts and status', () => {
  const { files, truncated } = parseDiff(diff);
  assert.equal(truncated, false);
  assert.deepEqual(
    files.map((file) => [file.path, file.status, file.additions, file.deletions, file.binary]),
    [
      ['src/a.ts', 'modified', 2, 1, false],
      ['docs/new.md', 'added', 1, 0, false],
      ['gone.txt', 'renamed', 0, 0, false],
      ['logo.png', 'modified', 0, 0, true],
    ],
  );
  assert.equal(files[2]!.oldPath, 'old.txt');
  assert.ok(files[0]!.patch.startsWith('@@ -1,2 +1,3 @@'));
  assert.equal(files[3]!.patch, '');
});

test('an empty diff has no files and huge patches are cut', () => {
  assert.deepEqual(parseDiff('').files, []);
  const big = `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -0,0 +1 @@\n+${'y'.repeat(70_000)}\n`;
  assert.equal(parseDiff(big).files[0]!.truncated, true);
});
