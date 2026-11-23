import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ChangesService } from './changes.ts';
import { Core } from './core.ts';
import { MemoryRunStore } from './store.ts';
import { FakeGitHub, FakeRepository, issue } from './testing.ts';

const patchFor = (...paths: string[]) =>
  paths
    .map(
      (path) =>
        `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-a\n+b\n`,
    )
    .join('');

function activeRun(core: Core, number: number) {
  const run = core.create(
    issue({ number, url: `https://github.com/acme/widgets/issues/${number}` }),
  );
  const worktreePath = mkdtempSync(join(tmpdir(), `overlap-${number}-`));
  core.update(run.id, (draft) => {
    draft.status = 'running';
    draft.baseBranch = 'main';
    draft.worktreePath = worktreePath;
  });
  return { id: run.id, worktreePath };
}

test('files changed by two unfinished runs are reported as overlaps', async () => {
  const core = new Core(new MemoryRunStore());
  const one = activeRun(core, 1);
  const two = activeRun(core, 2);
  const three = activeRun(core, 3);
  const patches = new Map([
    [one.worktreePath, patchFor('src/app.ts', 'README.md')],
    [two.worktreePath, patchFor('src/app.ts')],
    [three.worktreePath, patchFor('docs/other.md')],
  ]);
  const repository = new FakeRepository();
  repository.patch = async (worktree: string) => patches.get(worktree) ?? '';
  const service = new ChangesService(core, new FakeGitHub(), repository);
  const overlaps = await service.overlaps();
  assert.deepEqual(
    overlaps.map((entry) => [entry.path, entry.runIds.sort()]),
    [['src/app.ts', [one.id, two.id].sort()]],
  );
});

test('finished runs and a missing repository produce no overlaps', async () => {
  const core = new Core(new MemoryRunStore());
  const one = activeRun(core, 1);
  const two = activeRun(core, 2);
  core.update(two.id, (draft) => void (draft.status = 'done'));
  const repository = new FakeRepository();
  repository.patchText = patchFor('src/app.ts');
  assert.deepEqual(await new ChangesService(core, new FakeGitHub(), repository).overlaps(), []);
  assert.deepEqual(await new ChangesService(core, new FakeGitHub()).overlaps(), []);
  void one;
});
