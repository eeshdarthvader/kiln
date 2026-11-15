import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { smokeClient } from './smoke-http.mjs';

// Opt-in live check. Native mode requires a person answering in OpenCode.
const native = process.argv.includes('--native');
const { base, request } = smokeClient(
  process.env.SAWD_URL ?? 'http://127.0.0.1:3775',
  process.env.SAWD_API_TOKEN ? `Bearer ${process.env.SAWD_API_TOKEN}` : undefined,
);
await request('/readyz');
const { agents } = await request('/v1/agents');
const agent = process.env.SAWD_SMOKE_AGENT
  ? agents.find((candidate) => candidate.id === process.env.SAWD_SMOKE_AGENT)
  : agents.find((candidate) => /gpt-6-luna/i.test(candidate.name));
assert.ok(agent, 'Select SAWD_SMOKE_AGENT or enable gpt-6-luna.');
const id = `smoke-${randomUUID()}`;
const path = `/v1/tasks/${id}`;
const reviewMarker = 'SAWD_INLINE_REVIEW_CONFIRMED';
const definition = {
  title: native ? 'SAWD native interaction check' : 'SAWD reporting check',
  input: {
    instructions: `This is a bounded SAWD acceptance test. ${native ? 'You may create and revise only IMPLEMENTATION_PLAN.md using native file tools. Do not run commands, delegate, or contact external services.' : 'Do not run commands, edit files, delegate, or contact external services.'} Use the reporting MCP for reporting and the native OpenCode conversation for task context and human interaction.
1. Read reporting instructions and the current OpenCode conversation. Publish a plan with stable steps prepare, evidence, verify, initially prepare running and the others pending. ${native ? 'Create IMPLEMENTATION_PLAN.md describing this bounded reporting check and save its full content as a text/markdown artifact titled "Smoke plan".' : 'Create an artifact titled "Smoke plan", content "Validate SAWD reporting.", mediaType "text/plain".'}
${native ? '2. Report input_required with summary exactly "Waiting for native plan review". End this turn with a final chat message asking the user to review IMPLEMENTATION_PLAN.md using inline comments and submit them through the normal chat composer. Never use the question tool for plan review or approval. On the next user message, read the current conversation and report running, apply the inline feedback to the file, and save its full revised content as a new immutable text/markdown artifact titled "Smoke plan revised". Then report input_required with summary exactly "Waiting for native plan approval" and end that turn with a final chat message asking the user to review the revision and send "Approve" through the normal chat composer. Do not continue in the same turn. Only after a subsequent explicit user approval, read the current conversation and report running, then continue with step 3. Do not approve your own plan or treat revision feedback as approval.' : '2. Continue independently without requesting input.'}
3. Complete prepare and start evidence. Save a decision with title "Smoke decision", summary "Use a bounded check", rationale "No external changes are necessary"; evidence titled "Smoke evidence" with text "Reporting verified"; and a context_reference titled "Protocol reference" to https://example.com without fetching it.
4. Complete all plan steps and report done with summary exactly "SAWD live smoke passed". End normally.`,
  },
  acceptanceCriteria: [
    'Four attachment kinds retained',
    'Plan completed',
    'Explicit completion reported',
    ...(native ? ['Inline plan feedback applied before a separate chat approval'] : []),
  ],
  labels: ['acceptance-test'],
  executor: agent.id,
};
const accepted = await request(path, 'PUT', definition);
assert.deepEqual(accepted.setup, { status: 'pending' });
assert.equal(accepted.report, null);
assert.equal(accepted.runtimeUrl, null);
assert.deepEqual(accepted.input, definition.input);
assert.deepEqual(accepted.plan, { steps: [] });
assert.equal((await request(path, 'PUT', definition)).id, id);
const listed = (await request('/v1/tasks')).tasks.find((task) => task.id === id);
assert.ok(listed);
for (const field of ['input', 'acceptanceCriteria', 'plan', 'attachments'])
  assert.equal(field in listed, false, `Task list must omit ${field}.`);
await request(`${path}/start`, 'POST');
await request(`${path}/start`, 'POST');
console.log(`Started ${id} with ${agent.name}`);
if (native)
  console.log('Wait for the plan review notice below, then review in the native OpenCode UI.');
let previousStatus;
let runtimeUrl;
let initialReview;
let revisedReview;
let initialCompletion;
let completed = false;
const deadline = Date.now() + (native ? 840_000 : 300_000);
while (Date.now() < deadline) {
  const task = await request(path);
  if (!runtimeUrl) {
    runtimeUrl = task.runtimeUrl;
    if (runtimeUrl) console.log(`OpenCode: ${runtimeUrl}`);
  }
  const status = task.report?.status;
  if (status !== previousStatus) console.log(`Reported status: ${status ?? 'none'}`);
  previousStatus = status;
  assert.ok(
    !['failed', 'unknown'].includes(task.setup.status),
    'Task setup failed or delivery is unknown; inspect OpenCode.',
  );
  assert.notEqual(status, 'failed', 'Task reported failure; inspect OpenCode.');
  for (const field of ['status', 'summary', 'cancellation', 'deadlineAt', 'workVersion'])
    assert.equal(field in task, false, `Task detail must omit ${field}.`);
  assert.equal(task.archivedAt, null);
  assert.equal('inputRequests' in task, false);
  assert.equal('interactions' in task, false);
  assert.deepEqual(task.input, definition.input);
  if (native && status === 'input_required') {
    if (!initialReview && task.report.summary === 'Waiting for native plan review') {
      const artifact = task.attachments.find(
        (item) => item.kind === 'artifact' && item.title === 'Smoke plan',
      );
      assert.ok(artifact, 'Initial plan artifact was not saved before review.');
      assert.equal(artifact.mediaType, 'text/markdown');
      assert.ok(
        !artifact.content.includes(reviewMarker),
        'Initial plan already has review feedback.',
      );
      initialReview = { receivedAt: task.report.receivedAt, artifact };
      console.log(
        `Open IMPLEMENTATION_PLAN.md in OpenCode, add an inline comment: "Add a final checklist item: ${reviewMarker}: Verify that this smoke check makes no external changes." Then submit it with "Apply my inline comment and return the revised plan for review" through the normal chat composer. Do not answer through a question dialog.`,
      );
    } else if (!revisedReview && task.report.summary === 'Waiting for native plan approval') {
      assert.ok(initialReview, 'Initial native plan review was not observed.');
      assert.ok(
        task.report.receivedAt > initialReview.receivedAt,
        'Feedback needs a fresh status report.',
      );
      assert.deepEqual(
        task.attachments.find((item) => item.id === initialReview.artifact.id),
        initialReview.artifact,
      );
      const artifact = task.attachments.find(
        (item) => item.kind === 'artifact' && item.title === 'Smoke plan revised',
      );
      assert.ok(artifact, 'Revised plan artifact was not saved before approval.');
      assert.equal(artifact.mediaType, 'text/markdown');
      assert.notEqual(artifact.id, initialReview.artifact.id);
      assert.ok(
        artifact.content.includes(reviewMarker),
        'Inline feedback is absent from revision.',
      );
      revisedReview = { receivedAt: task.report.receivedAt, artifact };
      console.log(
        `Review the revised IMPLEMENTATION_PLAN.md for ${reviewMarker}, then send "Approve" through the normal chat composer.`,
      );
    }
  }
  if (status === 'done') {
    assert.equal(task.setup.status, 'submitted');
    assert.ok(task.runtimeUrl, 'Task detail must include the OpenCode session URL.');
    assert.deepEqual(
      new Set(task.attachments.map((item) => item.kind)),
      new Set(['artifact', 'decision', 'evidence', 'context_reference']),
    );
    assert.deepEqual(
      task.plan.steps.map((step) => step.id),
      ['prepare', 'evidence', 'verify'],
    );
    assert.ok(task.plan.steps.every((step) => step.status === 'completed'));
    if (native && !initialCompletion) {
      assert.ok(initialReview && revisedReview, 'Both native plan review turns must be observed.');
      assert.ok(
        task.report.receivedAt > revisedReview.receivedAt,
        'Approval needs a fresh status report.',
      );
      for (const review of [initialReview, revisedReview])
        assert.deepEqual(
          task.attachments.find((item) => item.id === review.artifact.id),
          review.artifact,
        );
      assert.equal(task.report.summary, 'SAWD live smoke passed');
      initialCompletion = task;
      console.log(
        'In the same OpenCode session, send: "Use the current conversation. Retain the plan and attachments. Report running, then done with summary exactly SAWD native follow-up passed. Do not repeat the initial test."',
      );
    } else if (!native || task.report.receivedAt > initialCompletion.report.receivedAt) {
      assert.equal(
        task.report.summary,
        native ? 'SAWD native follow-up passed' : 'SAWD live smoke passed',
      );
      if (native) {
        assert.deepEqual(task.attachments, initialCompletion.attachments);
        assert.equal(task.runtimeUrl, runtimeUrl);
      }
      completed = true;
      break;
    }
  }
  await delay(1500);
}
assert.ok(completed, 'Live check timed out; inspect the retained task.');
const archived = await request(`${path}/archive`, 'POST');
assert.equal(archived.report.status, 'done');
assert.ok(archived.archivedAt);
assert.equal((await request(`${path}/archive`, 'POST')).archivedAt, archived.archivedAt);
console.log(`Passed: ${new URL(path, base)}`);
