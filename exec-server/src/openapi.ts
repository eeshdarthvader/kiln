import { z } from 'zod';
import { attachmentSchema, idSchema, reportSchema, submissionSchema } from './validation.ts';

type Schema = Record<string, unknown>;
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const dateTime = { type: 'string', format: 'date-time' };
const nullableDateTime = { anyOf: [dateTime, { type: 'null' }] };
const object = (properties: Schema, required = Object.keys(properties)): Schema => ({
  type: 'object',
  properties,
  required,
});
const record = (value: unknown): Schema =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Schema) : {};

// Zod refinements are not emitted as JSON Schema. Add the representable rules and
// describe constraints that require comparison with retained task state.
function constraints(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(constraints);
  if (value === null || typeof value !== 'object') return value;
  const schema = Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, constraints(item)]),
  );
  const properties = record(schema.properties);
  if (record(properties.kind).const === 'evidence')
    schema.anyOf = [{ required: ['text'] }, { required: ['url'] }];
  if (properties.url)
    properties.url = {
      ...record(properties.url),
      description: 'HTTP(S) URL without embedded credentials; never fetched by the server.',
    };
  if (properties.steps)
    properties.steps = {
      ...record(properties.steps),
      description:
        'Ordered steps with unique IDs. Replacement is atomic; an empty list clears the plan.',
    };
  return schema;
}

function inputSchema(schema: z.ZodType): Schema {
  const { $schema: _dialect, ...definition } = z.toJSONSchema(schema, { io: 'input' });
  return constraints(definition) as Schema;
}

function outputSchema(schema: Schema): Schema {
  const result = structuredClone(schema);
  function allowAdditions(value: unknown): void {
    if (Array.isArray(value)) {
      value.forEach(allowAdditions);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    const node = record(value);
    if (node.additionalProperties === false) delete node.additionalProperties;
    Object.values(node).forEach(allowAdditions);
  }
  allowAdditions(result);
  return result;
}

const submission = inputSchema(submissionSchema);
const submissionProperties = record(submission.properties);
const attachmentInput = inputSchema(attachmentSchema);
const attachment = outputSchema({
  oneOf: (attachmentInput.oneOf as Schema[]).map((variant) => ({
    ...variant,
    additionalProperties: true,
    properties: { ...record(variant.properties), id: ref('Id'), createdAt: dateTime },
    required: [...(variant.required as string[]), 'id', 'createdAt'],
  })),
});
const summaryProperties = {
  id: ref('Id'),
  title: submissionProperties.title,
  labels: submissionProperties.labels,
  executor: submissionProperties.executor,
  setup: ref('TaskSetup'),
  report: { anyOf: [ref('TaskReport'), { type: 'null' }] },
  archivedAt: nullableDateTime,
  runtimeUrl: {
    type: ['string', 'null'],
    format: 'uri',
    description: 'OpenCode session URL without credentials. Runtime authentication is separate.',
  },
  createdAt: dateTime,
  updatedAt: dateTime,
};
export const apiErrorCodes = [
  'VALIDATION_FAILED',
  'UNAUTHORIZED',
  'TASK_NOT_FOUND',
  'EXECUTOR_NOT_FOUND',
  'ROUTE_NOT_FOUND',
  'IDEMPOTENCY_CONFLICT',
  'TASK_STATE_CONFLICT',
  'PAYLOAD_TOO_LARGE',
  'INTERNAL_ERROR',
  'NOT_READY',
  'UI_NOT_BUILT',
] as const;

const schemas = {
  OpenCodeConnection: object({
    url: { type: 'string', format: 'uri' },
    password: { type: 'string', description: 'Runtime password for username opencode.' },
  }),
  Id: inputSchema(idSchema),
  Submission: {
    ...submission,
    description:
      'Immutable initial request. Acceptance does not start setup. Labels and acceptance criteria default to empty arrays. Normalized identical submissions are idempotent.',
  },
  AttachmentInput: attachmentInput,
  Attachment: attachment,
  Plan: outputSchema(record(record(inputSchema(reportSchema).properties).plan)),
  Report: {
    ...inputSchema(reportSchema),
    description:
      'Agent assertion only. Latest newly accepted report wins without native-turn or runtime verification. New reports remain allowed after done, failed, or archival. Omit plan to preserve it; empty steps clear it. No execution side effects.',
  },
  ReportReceipt: object({ taskId: ref('Id'), operationId: ref('Id'), receivedAt: dateTime }),
  TaskReport: object({
    status: { type: 'string', enum: ['running', 'input_required', 'done', 'failed'] },
    summary: { type: 'string', minLength: 1, maxLength: 20_000 },
    receivedAt: dateTime,
  }),
  TaskSetup: object(
    {
      status: { type: 'string', enum: ['pending', 'starting', 'submitted', 'failed', 'unknown'] },
      error: object({
        code: { type: 'string', enum: ['SETUP_FAILED', 'DELIVERY_UNKNOWN'] },
        message: { type: 'string' },
      }),
    },
    ['status'],
  ),
  TaskSummary: object(outputSchema(summaryProperties)),
  Task: object({
    ...outputSchema(summaryProperties),
    input: outputSchema(record(submissionProperties.input)),
    acceptanceCriteria: submissionProperties.acceptanceCriteria,
    plan: ref('Plan'),
    attachments: { type: 'array', items: ref('Attachment') },
  }),
  Agent: object({
    id: ref('Id'),
    name: { type: 'string' },
    description: { type: 'string' },
    capabilities: {
      type: 'array',
      items: { type: 'string', enum: ['git', 'node', 'python', 'docker'] },
    },
  }),
  Error: object({
    error: object(
      {
        code: { type: 'string', enum: apiErrorCodes },
        message: { type: 'string' },
        details: { type: 'object', additionalProperties: true },
      },
      ['code', 'message'],
    ),
  }),
};

const json = (schema: Schema) => ({ 'application/json': { schema } });
const response = (description: string, schema: Schema) => ({ description, content: json(schema) });
const taskResponse = (description: string) => response(description, ref('Task'));
const failure = (description: string) => response(description, ref('Error'));
const errors = {
  '400': failure('VALIDATION_FAILED: invalid JSON, ID, or schema.'),
  '401': failure('UNAUTHORIZED: configured bearer token is missing or invalid.'),
  '404': failure('TASK_NOT_FOUND, EXECUTOR_NOT_FOUND, or ROUTE_NOT_FOUND.'),
  '409': failure('IDEMPOTENCY_CONFLICT or TASK_STATE_CONFLICT.'),
  '413': failure('PAYLOAD_TOO_LARGE: JSON body exceeds 1 MB.'),
  '500': failure('INTERNAL_ERROR: sanitized unexpected failure.'),
  '503': failure('NOT_READY: bootstrap/shutdown gate rejects mutations.'),
};
const taskPath = { parameters: [{ name: 'id', in: 'path', required: true, schema: ref('Id') }] };

export const openApiDocument = {
  openapi: '3.1.0',
  jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
  info: {
    title: 'SAWD reporting API',
    version: '1.0.0',
    description:
      'Pre-release /v1 contract changes in place; deploy UI and consumers together. One-time workspace/session setup and initial instructions; subsequent runtime interaction belongs to OpenCode. Reports are agent assertions, not verified runtime state. State and idempotency records are in memory with no recovery, pagination, or streaming feed. Unknown request fields are rejected and JSON bodies are limited to 1 MB. Clients must ignore additive response fields. Bearer auth is required only when SAWD_API_TOKEN is configured. Health and UI assets are public. MCP uses non-secret task URLs on a trusted loopback listener with no native attribution; domain errors are JSON text with isError:true (SDK argument validation may return plain text). All runtime cancellation, deadlines, and permissions belong outside this reporting API.',
  },
  servers: [{ url: '/' }],
  security: [{ bearerAuth: [] }],
  paths: {
    '/healthz': {
      get: {
        operationId: 'getLiveness',
        security: [],
        responses: { '200': response('Process is alive.', object({ alive: { const: true } })) },
      },
    },
    '/readyz': {
      get: {
        operationId: 'getReadiness',
        security: [],
        responses: {
          '200': response('Ready.', object({ ready: { const: true } })),
          '503': response(
            'Not ready; not a continuous runtime probe.',
            object({ ready: { const: false } }),
          ),
        },
      },
    },
    '/v1/openapi.json': {
      get: {
        operationId: 'getOpenApi',
        responses: {
          '200': response('This OpenAPI 3.1 contract.', { type: 'object' }),
          '401': errors['401'],
        },
      },
    },
    '/v1/agents': {
      get: {
        operationId: 'listAgents',
        responses: {
          '200': response(
            'Discovered initial model profiles; IDs are opaque.',
            object({
              schemaVersion: { const: 1 },
              agents: { type: 'array', items: ref('Agent') },
            }),
          ),
          '401': errors['401'],
          '500': errors['500'],
        },
      },
    },
    '/v1/opencode/connection': {
      get: {
        operationId: 'getOpenCodeConnection',
        description:
          'Read browser login details on explicit request. The password grants server-wide OpenCode access; API authorization applies and the response must not be cached.',
        responses: {
          '200': {
            ...response('OpenCode login URL and password.', ref('OpenCodeConnection')),
            headers: { 'Cache-Control': { schema: { const: 'no-store' } } },
          },
          '401': errors['401'],
          '503': failure('NOT_READY: runtime login details are unavailable.'),
        },
      },
    },
    '/v1/tasks': {
      get: {
        operationId: 'listTasks',
        responses: {
          '200': response(
            'All task summaries in acceptance order, including archived tasks. Omits instructions, criteria, plan and attachments.',
            object({ tasks: { type: 'array', items: ref('TaskSummary') } }),
          ),
          '401': errors['401'],
          '500': errors['500'],
        },
      },
    },
    '/v1/tasks/{id}': {
      ...taskPath,
      get: {
        operationId: 'getTask',
        responses: {
          '200': {
            ...taskResponse('Current task, setup state, latest report and attachments.'),
            headers: { 'Cache-Control': { schema: { const: 'no-store' } } },
          },
          ...errors,
        },
      },
      put: {
        operationId: 'submitTask',
        description:
          'Accept without starting. Object key order is ignored; array order is preserved. Conflicting ID reuse returns 409.',
        requestBody: { required: true, content: json(ref('Submission')) },
        responses: {
          '200': taskResponse('Identical accepted request; current task.'),
          '201': taskResponse('Accepted task; setup pending and report null.'),
          ...errors,
        },
      },
    },
    '/v1/tasks/{id}/start': {
      ...taskPath,
      post: {
        operationId: 'startTask',
        description:
          'One-time workspace/session creation and initial prompt submission. Concurrent calls share setup. Submitted or failed setup is not relaunched. Unknown delivery may be reconciled read-only; it is never blindly resent. Setup outcomes are separate from agent reports. Body values are ignored.',
        responses: { '200': taskResponse('Current task including setup result.'), ...errors },
      },
    },
    '/v1/tasks/{id}/archive': {
      ...taskPath,
      post: {
        operationId: 'archiveTask',
        description:
          'Set archivedAt once in any state. Display metadata only; does not stop work, block setup, or reject later reports. Body values are ignored.',
        responses: { '200': taskResponse('Task with archival timestamp.'), ...errors },
      },
    },
  },
  components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } }, schemas },
};
