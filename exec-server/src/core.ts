import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import {
  SawdError,
  fingerprint,
  type AgentProfile,
  type Attachment,
  type ReportReceipt,
  type Task,
  type TaskRecord,
  type TaskSetup,
  type TaskSummary,
} from './domain.ts';
import { attachmentSchema, idSchema, parse, reportSchema, submissionSchema } from './validation.ts';
import { reportingInstructionsReference } from './reporting-instructions.ts';

export class Core {
  readonly records = new Map<string, TaskRecord>();
  private readonly agents: AgentProfile[];
  constructor(profiles: AgentProfile[]) {
    if (profiles.some((profile) => !isAbsolute(profile.workspaceRoot)))
      throw new SawdError('Agent workspace roots must be absolute.');
    this.agents = structuredClone(profiles);
  }
  listAgents() {
    return this.agents.map(({ id, name, description, capabilities }) => ({
      id,
      name,
      description,
      capabilities: [...capabilities],
    }));
  }
  profile(id: string): AgentProfile {
    const profile = this.agents.find((item) => item.id === id);
    if (!profile) throw new SawdError('Executor not found.', 404, 'EXECUTOR_NOT_FOUND');
    return structuredClone(profile);
  }
  accept(id: string, payload: unknown): { created: boolean; task: Task } {
    parse(idSchema, id);
    const submission = parse(submissionSchema, payload);
    const hash = fingerprint(submission);
    const existing = this.records.get(id);
    if (existing) {
      if (existing.submissionHash !== hash)
        throw new SawdError(
          'Task ID was reused with different content.',
          409,
          'IDEMPOTENCY_CONFLICT',
        );
      return { created: false, task: this.get(id) };
    }
    const profile = this.profile(submission.executor);
    const now = new Date().toISOString();
    this.records.set(id, {
      task: {
        ...submission,
        id,
        setup: { status: 'pending' },
        report: null,
        archivedAt: null,
        runtimeUrl: null,
        plan: { steps: [] },
        attachments: [],
        createdAt: now,
        updatedAt: now,
      },
      submissionHash: hash,
      threadId: randomUUID(),
      workspacePath: join(profile.workspaceRoot, randomUUID()),
      operations: new Map(),
    });
    return { created: true, task: this.get(id) };
  }
  list(): TaskSummary[] {
    return [...this.records.values()].map(({ task }) => {
      const {
        input: _input,
        acceptanceCriteria: _criteria,
        plan: _plan,
        attachments: _attachments,
        ...summary
      } = task;
      return structuredClone(summary);
    });
  }
  record(id: string): TaskRecord {
    parse(idSchema, id);
    const record = this.records.get(id);
    if (!record) throw new SawdError('Task not found.', 404);
    return record;
  }
  get(id: string): Task {
    return structuredClone(this.record(id).task);
  }
  start(id: string): Task {
    if (this.record(id).task.setup.status === 'pending')
      return this.setSetup(id, { status: 'starting' });
    return this.get(id);
  }
  setSetup(id: string, setup: TaskSetup, runtimeUrl?: string | null): Task {
    const record = this.record(id);
    record.task.setup = structuredClone(setup);
    if (runtimeUrl !== undefined) record.task.runtimeUrl = runtimeUrl;
    this.touch(record);
    return this.get(id);
  }
  initialMessage(id: string): string {
    const { task } = this.record(id);
    return JSON.stringify({
      type: 'task_start',
      taskId: id,
      title: task.title,
      input: task.input,
      acceptanceCriteria: task.acceptanceCriteria,
      instructions: reportingInstructionsReference,
    });
  }
  archive(id: string): Task {
    const record = this.record(id);
    if (!record.task.archivedAt) {
      record.task.archivedAt = new Date().toISOString();
      this.touch(record);
    }
    return this.get(id);
  }
  createAttachment(taskId: string, operationId: string, attachment: unknown): Attachment {
    const input = parse(attachmentSchema, attachment);
    return this.operation(taskId, operationId, { kind: 'attachment', input }, (record) => {
      const value: Attachment = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
      record.task.attachments.push(value);
      return value;
    });
  }
  reportStatus(taskId: string, operationId: string, report: unknown): ReportReceipt {
    const input = parse(reportSchema, report);
    return this.operation(taskId, operationId, { kind: 'report', input }, (record) => {
      const receivedAt = new Date().toISOString();
      if (input.plan) record.task.plan = structuredClone(input.plan);
      record.task.report = { status: input.status, summary: input.summary, receivedAt };
      return { taskId: record.task.id, operationId, receivedAt };
    });
  }
  touch(record: TaskRecord) {
    record.task.updatedAt = new Date().toISOString();
  }
  private operation<T>(
    taskId: string,
    operationId: string,
    input: unknown,
    apply: (record: TaskRecord) => T,
  ): T {
    parse(idSchema, operationId);
    const record = this.record(taskId);
    const hash = fingerprint(input);
    const existing = record.operations.get(operationId);
    if (existing) {
      if (existing.hash !== hash)
        throw new SawdError(
          'Operation ID was reused with different content.',
          409,
          'IDEMPOTENCY_CONFLICT',
        );
      return structuredClone(existing.result as T);
    }
    if (['pending', 'failed'].includes(record.task.setup.status))
      throw new SawdError('Reporting requires started task setup.', 409, 'TASK_STATE_CONFLICT', {
        setupStatus: record.task.setup.status,
      });
    const result = apply(record);
    this.touch(record);
    record.operations.set(operationId, { hash, result: structuredClone(result) });
    return structuredClone(result);
  }
}
