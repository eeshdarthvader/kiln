import { z } from 'zod';
import { FactoryError, stageNames } from './domain.ts';

export const idSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
export const stageSchema = z.enum([...stageNames, 'resolve']);
const readable = z.string().trim().min(1).max(20_000);
const title = z.string().trim().min(1).max(200);
const webUrl = z
  .url()
  .max(2000)
  .refine((value) => {
    const parsed = new URL(value);
    return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password;
  }, 'Use an HTTP or HTTPS URL without credentials.');
export const attachmentSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('decision'),
      title,
      summary: readable,
      rationale: readable,
      options: z.array(z.string().trim().min(1).max(500)).max(10).optional(),
      reversibility: z.enum(['cheap', 'costly', 'one_way']).optional(),
      blastRadius: z.string().trim().min(1).max(500).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('artifact'),
      title,
      content: z.string().max(200_000),
      mediaType: z.enum(['text/markdown', 'text/plain']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('evidence'),
      title,
      text: readable.optional(),
      url: webUrl.optional(),
    })
    .strict()
    .refine((value) => value.text || value.url, 'Provide evidence text or a URL.'),
  z
    .object({
      kind: z.literal('context_reference'),
      title,
      url: webUrl,
      description: readable.optional(),
    })
    .strict(),
]);
export const reportSchema = z
  .object({
    status: z.enum(['running', 'input_required', 'done', 'failed']),
    summary: readable,
    verdict: z.enum(['pass', 'changes_requested']).optional(),
    risk: z.enum(['low', 'high']).optional(),
    riskReason: readable.optional(),
    prUrl: webUrl.optional(),
    plan: z
      .object({
        steps: z
          .array(
            z
              .object({
                id: idSchema,
                text: z.string().trim().min(1).max(1000),
                status: z.enum(['pending', 'running', 'completed']),
              })
              .strict(),
          )
          .max(50)
          .refine(
            (steps) => new Set(steps.map((step) => step.id)).size === steps.length,
            'Plan step IDs must be unique.',
          ),
      })
      .strict()
      .optional(),
  })
  .strict();

const issueUrlPattern = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)\/?(?:[?#].*)?$/;
export const repoSchema = z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'Use the owner/name form.');
export const rejectSchema = z.object({ feedback: readable }).strict();
export const newRunSchema = z.object({ issueUrl: z.string().trim().max(500) }).strict();

export function parseIssueUrl(value: string): { repo: string; number: number } {
  const match = issueUrlPattern.exec(value.trim());
  if (!match)
    throw new FactoryError(
      'Enter a GitHub issue URL such as https://github.com/owner/repo/issues/12.',
    );
  return { repo: match[1]!, number: Number(match[2]) };
}

export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new FactoryError(
      result.error.issues
        .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
        .join('; '),
    );
  return result.data;
}
