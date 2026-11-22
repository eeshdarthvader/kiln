import { matchesGlob } from 'node:path';
import { z } from 'zod';
import { autonomyLevels, type Autonomy, type Change, type Run } from './domain.ts';

export const policyPath = '.factory/policy.json';

/** Dependency manifests and lockfiles. Any change to one counts as a dependency change. */
const dependencyFiles = new Set([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'pyproject.toml',
  'poetry.lock',
  'uv.lock',
  'Pipfile',
  'Pipfile.lock',
  'go.mod',
  'go.sum',
  'Cargo.toml',
  'Cargo.lock',
  'Gemfile',
  'Gemfile.lock',
  'composer.json',
  'composer.lock',
]);

const policySchema = z
  .object({
    autonomy: z.enum(autonomyLevels).optional(),
    critical: z
      .object({
        /** Glob patterns, matched against repository-relative paths. */
        paths: z.array(z.string().min(1).max(300)).max(100).default([]),
        maxChangedLines: z.number().int().positive().optional(),
        maxFiles: z.number().int().positive().optional(),
        dependencies: z.boolean().default(false),
      })
      .strict()
      .default({ paths: [], dependencies: false }),
  })
  .strict();

export interface Policy {
  autonomy: Autonomy;
  paths: string[];
  maxChangedLines?: number;
  maxFiles?: number;
  dependencies: boolean;
  /** Set when the policy file exists but cannot be used; the factory then fails safe. */
  problem?: string;
}

const safe = (autonomy: Autonomy): Autonomy => (autonomy === 'L0' ? 'L0' : 'L1');

/**
 * Reads the policy from the repository's base branch, never from the agent's branch. A missing
 * file means the factory-wide default. An unreadable one drops to L1 (draft PR, human merges).
 */
export function parsePolicy(text: string | null, fallback: Autonomy): Policy {
  if (text === null) return { autonomy: fallback, paths: [], dependencies: false };
  try {
    const parsed = policySchema.parse(JSON.parse(text));
    return {
      autonomy: parsed.autonomy ?? fallback,
      paths: parsed.critical.paths,
      ...(parsed.critical.maxChangedLines === undefined
        ? {}
        : { maxChangedLines: parsed.critical.maxChangedLines }),
      ...(parsed.critical.maxFiles === undefined ? {} : { maxFiles: parsed.critical.maxFiles }),
      dependencies: parsed.critical.dependencies,
    };
  } catch (error) {
    return {
      autonomy: safe(fallback),
      paths: [],
      dependencies: false,
      problem: `${policyPath} is not valid: ${(error as Error).message.slice(0, 200)}`,
    };
  }
}

/** Why a change is critical under the policy. Deterministic: no agent judgement is involved. */
export function criticalReasons(policy: Policy, changes: Change[]): string[] {
  const reasons: string[] = [];
  if (policy.problem) reasons.push(policy.problem);
  const guarded = (path: string) =>
    path.startsWith('.factory/') || policy.paths.some((pattern) => matchesGlob(path, pattern));
  const touched = changes.filter((change) => guarded(change.path)).map((change) => change.path);
  if (touched.length) reasons.push(`Touches protected paths: ${touched.slice(0, 5).join(', ')}`);
  if (policy.dependencies) {
    const manifests = changes
      .map((change) => change.path)
      .filter((path) => dependencyFiles.has(path.split('/').at(-1) ?? ''));
    if (manifests.length) reasons.push(`Changes dependencies: ${manifests.slice(0, 5).join(', ')}`);
  }
  const lines = changes.reduce((sum, change) => sum + change.added + change.deleted, 0);
  if (policy.maxChangedLines !== undefined && lines > policy.maxChangedLines)
    reasons.push(`Changes ${lines} lines (limit ${policy.maxChangedLines})`);
  if (policy.maxFiles !== undefined && changes.length > policy.maxFiles)
    reasons.push(`Changes ${changes.length} files (limit ${policy.maxFiles})`);
  return reasons;
}

/** One-way decisions the agents recorded. An agent can raise one but never lower it. */
export function oneWayDecisions(run: Pick<Run, 'attachments'>): string[] {
  return run.attachments.flatMap((attachment) =>
    attachment.kind === 'decision' && attachment.reversibility === 'one_way'
      ? [`One-way decision: ${attachment.title}`]
      : [],
  );
}
