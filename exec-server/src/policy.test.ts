import assert from 'node:assert/strict';
import { test } from 'node:test';
import { criticalReasons, oneWayDecisions, parsePolicy } from './policy.ts';

const change = (path: string, added = 1, deleted = 0) => ({ path, added, deleted });

test('no policy file means the factory-wide default and no rules', () => {
  const policy = parsePolicy(null, 'L2');
  assert.equal(policy.autonomy, 'L2');
  assert.deepEqual(criticalReasons(policy, [change('src/a.ts')]), []);
});

test('rules match paths, dependencies, size and file count', () => {
  const policy = parsePolicy(
    JSON.stringify({
      autonomy: 'L2',
      critical: {
        paths: ['src/auth/**', 'migrations/**'],
        dependencies: true,
        maxChangedLines: 10,
        maxFiles: 3,
      },
    }),
    'L1',
  );
  assert.equal(policy.autonomy, 'L2');
  assert.deepEqual(criticalReasons(policy, [change('src/ui/button.ts')]), []);
  const reasons = criticalReasons(policy, [
    change('src/auth/login.ts', 8, 2),
    change('migrations/001.sql'),
    change('web/package.json'),
    change('README.md'),
  ]);
  assert.equal(reasons.length, 4);
  assert.match(reasons[0]!, /protected paths: src\/auth\/login.ts, migrations\/001.sql/);
  assert.match(reasons.join('\n'), /dependencies: web\/package.json/);
  assert.match(reasons.join('\n'), /13 lines \(limit 10\)/);
  assert.match(reasons.join('\n'), /4 files \(limit 3\)/);
});

test('changes to the policy itself are always critical', () => {
  const policy = parsePolicy('{"autonomy":"L3"}', 'L1');
  assert.match(criticalReasons(policy, [change('.factory/policy.json')])[0]!, /protected paths/);
});

test('an invalid policy falls back to L1 and says why', () => {
  const policy = parsePolicy('{"autonomy":"L9"}', 'L3');
  assert.equal(policy.autonomy, 'L1');
  assert.match(criticalReasons(policy, [])[0]!, /policy.json is not valid/);
  assert.equal(parsePolicy('not json', 'L0').autonomy, 'L0');
});

test('one-way decisions are collected from attachments', () => {
  const base = { id: 'a', stage: 'plan' as const, createdAt: '', summary: 's', rationale: 'r' };
  assert.deepEqual(
    oneWayDecisions({
      attachments: [
        { ...base, kind: 'decision', title: 'Drop the column', reversibility: 'one_way' },
        { ...base, kind: 'decision', title: 'Name it', reversibility: 'cheap' },
        { ...base, kind: 'decision', title: 'Untagged' },
      ],
    }),
    ['One-way decision: Drop the column'],
  );
});
