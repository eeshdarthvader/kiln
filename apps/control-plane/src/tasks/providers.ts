import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Config } from '../config.ts';
import type { TaskProvider } from '../ports.ts';
import { CommandProvider } from './command.ts';
import { JiraProvider } from './jira.ts';

const repo = z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'Use the owner/name form.');
const name = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,30}$/, 'Use lowercase letters, digits and dashes.');

const schema = z
  .object({
    providers: z.array(
      z.discriminatedUnion('type', [
        z
          .object({
            name,
            type: z.literal('jira'),
            baseUrl: z.url(),
            email: z.string().min(1),
            /** Name of the environment variable holding the API token. Never the token itself. */
            tokenEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
            repo,
            repos: z.record(z.string(), repo).optional(),
            jql: z.string().max(500).optional(),
          })
          .strict(),
        z
          .object({
            name,
            type: z.literal('command'),
            command: z.array(z.string().min(1)).min(1),
            repo,
            urlPattern: z.string().max(300).optional(),
          })
          .strict(),
      ]),
    ),
  })
  .strict();

/** Where task providers are configured: FACTORY_TASK_PROVIDERS, else `providers.json` in the factory home. */
export function providersPath(config: Config, env: NodeJS.ProcessEnv): string | undefined {
  const path = env.FACTORY_TASK_PROVIDERS ?? join(config.home, 'providers.json');
  return env.FACTORY_TASK_PROVIDERS || existsSync(path) ? path : undefined;
}

export function loadProviders(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
): TaskProvider[] {
  const path = providersPath(config, env);
  if (!path) return [];
  let parsed;
  try {
    parsed = schema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    throw new Error(`Task providers file ${path} is invalid: ${(error as Error).message}`);
  }
  const seen = new Set<string>();
  return parsed.providers.map((entry) => {
    if (seen.has(entry.name)) throw new Error(`Task provider "${entry.name}" is listed twice.`);
    seen.add(entry.name);
    if (entry.type === 'command')
      return new CommandProvider({
        name: entry.name,
        command: entry.command,
        repo: entry.repo,
        ...(entry.urlPattern ? { urlPattern: entry.urlPattern } : {}),
      });
    const token = env[entry.tokenEnv];
    if (!token) throw new Error(`Task provider "${entry.name}" needs ${entry.tokenEnv} to be set.`);
    return new JiraProvider({
      name: entry.name,
      baseUrl: entry.baseUrl,
      email: entry.email,
      token,
      repo: entry.repo,
      ...(entry.repos ? { repos: entry.repos } : {}),
      ...(entry.jql ? { jql: entry.jql } : {}),
    });
  });
}
