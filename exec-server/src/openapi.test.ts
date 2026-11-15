import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { z } from 'zod';
import { applications } from './app.ts';
import { Core } from './core.ts';
import { apiErrorCodes, openApiDocument } from './openapi.ts';
import { reportSchema, submissionSchema } from './validation.ts';

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as ObjectValue;
}

test('OpenAPI document has resolvable schemas, required properties, and operation IDs', () => {
  assert.equal(openApiDocument.openapi, '3.1.0');
  const document = object(JSON.parse(JSON.stringify(openApiDocument)));
  let references = 0;
  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    const schema = object(value);
    if (typeof schema.$ref === 'string') {
      assert.ok(schema.$ref.startsWith('#/'));
      let target: unknown = document;
      for (const part of schema.$ref.slice(2).split('/')) {
        target = object(target)[part];
        assert.notEqual(target, undefined, `Unresolved reference: ${schema.$ref}`);
      }
      references++;
    }
    if (Array.isArray(schema.required) && schema.properties) {
      const properties = object(schema.properties);
      for (const property of schema.required)
        assert.ok(String(property) in properties, `Missing required property: ${property}`);
    }
    for (const keyword of ['anyOf', 'oneOf', 'allOf'])
      if (keyword in schema) assert.ok(Array.isArray(schema[keyword]) && schema[keyword].length);
    Object.values(schema).forEach(visit);
  }
  visit(document);
  assert.ok(references > 20);
  const operationIds: string[] = [];
  for (const item of Object.values(openApiDocument.paths))
    for (const [method, operation] of Object.entries(item))
      if (['get', 'post', 'put'].includes(method)) {
        const id = object(operation).operationId;
        assert.equal(typeof id, 'string');
        operationIds.push(String(id));
        assert.ok(Object.keys(object(object(operation).responses)).length);
      }
  assert.equal(new Set(operationIds).size, operationIds.length);
});

test('OpenAPI retains the runtime input properties, required fields, and strict boundaries', () => {
  for (const [name, schema] of [
    ['Submission', submissionSchema],
    ['Report', reportSchema],
  ] as const) {
    const generated = z.toJSONSchema(schema, { io: 'input' });
    const published = object(openApiDocument.components.schemas[name]);
    assert.deepEqual(Object.keys(object(published.properties)), Object.keys(generated.properties!));
    assert.deepEqual(published.required, generated.required);
    assert.equal(published.additionalProperties, false);
  }
  const submission = {
    title: 'Task',
    input: { instructions: 'Implement the task.' },
    acceptanceCriteria: [],
    labels: [],
    executor: 'agent',
  };
  for (const legacyField of ['autonomy', 'initiator'] as const) {
    assert.equal(
      legacyField in object(object(openApiDocument.components.schemas.Submission).properties),
      false,
    );
    assert.equal(legacyField in object(openApiDocument.components.schemas.Task.properties), false);
    assert.equal(
      submissionSchema.safeParse({
        ...submission,
        [legacyField]: legacyField === 'autonomy' ? 'guided' : 'tester',
      }).success,
      false,
    );
  }
  const task = openApiDocument.components.schemas.Task;
  const taskProperties = object(task.properties);
  for (const key of ['input', 'setup', 'report', 'runtimeUrl', 'archivedAt'])
    assert.ok((task.required as string[]).includes(key));
  for (const key of ['status', 'summary', 'workVersion', 'cancellation', 'deadlineAt'])
    assert.equal(key in taskProperties, false);
  assert.deepEqual(
    object(object(openApiDocument.components.schemas.TaskReport.properties).status).enum,
    ['running', 'input_required', 'done', 'failed'],
  );
  assert.deepEqual(
    object(object(openApiDocument.components.schemas.TaskSetup.properties).status).enum,
    ['pending', 'starting', 'submitted', 'failed', 'unknown'],
  );
  const summary = object(openApiDocument.components.schemas.TaskSummary.properties);
  for (const key of ['input', 'acceptanceCriteria', 'plan', 'attachments'])
    assert.equal(key in summary, false);
  assert.deepEqual(
    object(object(openApiDocument.components.schemas.Report).properties).status,
    object(object(openApiDocument.components.schemas.TaskReport).properties).status,
  );
  for (const name of [
    'Cancel',
    'Cancellation',
    'FollowUp',
    'Question',
    'InputResponse',
    'InputRequest',
    'Interaction',
  ])
    assert.equal(name in openApiDocument.components.schemas, false);
  for (const path of [
    '/v1/tasks/{id}/cancel',
    '/v1/tasks/{id}/runtime-link',
    '/v1/tasks/{id}/follow-ups',
    '/v1/t3/pairing',
  ])
    assert.equal(path in openApiDocument.paths, false);
  assert.ok(apiErrorCodes.includes('UNAUTHORIZED'));
  assert.ok(apiErrorCodes.includes('IDEMPOTENCY_CONFLICT'));
});

test('nested response objects allow additions while request objects remain strict', () => {
  const schemas = object(openApiDocument.components.schemas);
  const visited = new Set<string>();
  function checkResponse(value: unknown): void {
    if (Array.isArray(value)) {
      value.forEach(checkResponse);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    const schema = object(value);
    assert.notEqual(schema.additionalProperties, false);
    if (typeof schema.$ref === 'string' && !visited.has(schema.$ref)) {
      visited.add(schema.$ref);
      checkResponse(schemas[schema.$ref.split('/').at(-1)!]);
    }
    Object.values(schema).forEach(checkResponse);
  }
  for (const item of Object.values(openApiDocument.paths))
    for (const [method, operation] of Object.entries(item))
      if (['get', 'post', 'put'].includes(method)) checkResponse(object(operation).responses);
  assert.ok(visited.has('#/components/schemas/Task'));
  const properties = (schema: unknown) => object(object(schema).properties);
  const submittedInput = object(properties(schemas.Submission).input);
  const returnedInput = object(properties(schemas.Task).input);
  assert.equal(submittedInput.additionalProperties, false);
  assert.notEqual(returnedInput.additionalProperties, false);
  assert.deepEqual(returnedInput.required, submittedInput.required);
  assert.deepEqual(returnedInput.properties, submittedInput.properties);
  assert.equal(object(schemas.Attachment).oneOf instanceof Array, true);
  assert.equal((object(schemas.Attachment).oneOf as unknown[]).length, 4);
});

test('every registered business and probe route has an OpenAPI operation and linked request schema', async () => {
  const source = await readFile(new URL('./app.ts', import.meta.url), 'utf8');
  const registered = [...source.matchAll(/app\.(get|put|post)\('([^']+)'/g)]
    .map(([, method, path]) => `${method} ${path.replace(/:([\w]+)/g, '{$1}')}`)
    .sort();
  const documented = Object.entries(openApiDocument.paths)
    .flatMap(([path, item]) =>
      Object.keys(item)
        .filter((method) => ['get', 'post', 'put'].includes(method))
        .map((method) => `${method} ${path}`),
    )
    .sort();
  assert.deepEqual(documented, registered);
  for (const [path, method, name] of [['/v1/tasks/{id}', 'put', 'Submission']]) {
    const operation = object(object(object(openApiDocument.paths)[path])[method]);
    const content = object(object(operation.requestBody).content);
    assert.deepEqual(object(content['application/json']).schema, {
      $ref: `#/components/schemas/${name}`,
    });
  }
  assert.ok(openApiDocument.paths['/v1/tasks/{id}/start'].post.responses['200']);
});

test('OpenAPI is served behind API authorization while probes remain public', async (t) => {
  const server = applications(new Core([]), () => true, 'secret').app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  assert.equal((await fetch(`${base}/v1/openapi.json`)).status, 401);
  const response = await fetch(`${base}/v1/openapi.json`, {
    headers: { authorization: 'Bearer secret' },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), openApiDocument);
  for (const path of ['/healthz', '/readyz']) {
    assert.equal((await fetch(`${base}${path}`)).status, 200);
    assert.deepEqual(object(object(object(openApiDocument.paths)[path]).get).security, []);
  }
  assert.deepEqual(openApiDocument.components.securitySchemes.bearerAuth, {
    type: 'http',
    scheme: 'bearer',
  });
  assert.deepEqual(openApiDocument.security, [{ bearerAuth: [] }]);
});
