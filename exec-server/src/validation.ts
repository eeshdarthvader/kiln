import { z } from 'zod';
import { SawdError } from './domain.ts';

export const idSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const readable = z.string().trim().min(1).max(20_000);
const title = z.string().trim().min(1).max(200);
const webUrl = z
  .url()
  .max(2000)
  .refine((value) => {
    const parsed = new URL(value);
    return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password;
  }, 'Use an HTTP or HTTPS URL without credentials.');
const documentFields = {
  title,
  content: z.string().max(200_000),
  mediaType: z.enum(['text/markdown', 'text/plain']),
};
export const attachmentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('decision'), title, summary: readable, rationale: readable }).strict(),
  z.object({ kind: z.literal('artifact'), ...documentFields }).strict(),
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
export const submissionSchema = z
  .object({
    title,
    input: z.object({ instructions: readable }).strict(),
    acceptanceCriteria: z.array(z.string().trim().min(1).max(2000)).max(50).default([]),
    labels: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
    executor: idSchema,
  })
  .strict();
export const reportSchema = z
  .object({
    status: z.enum(['running', 'input_required', 'done', 'failed']),
    summary: readable,
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
export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new SawdError(
      result.error.issues
        .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
        .join('; '),
    );
  return result.data;
}
