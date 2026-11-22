import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  FactoryError,
  activeStage,
  branchName,
  fingerprint,
  type Attachment,
  type AttachmentInput,
  type Issue,
  type ReportReceipt,
  type Run,
  type RunRecord,
  type RunSummary,
  type StageName,
  type StageReport,
} from './domain.ts';
import type { RunStore } from './store.ts';
import { attachmentSchema, idSchema, parse, reportSchema, stageSchema } from './validation.ts';

/**
 * Owns every run record: validates agent writes, persists each change and announces it.
 * It holds no pipeline logic; the pipeline listens for `report` and decides what happens next.
 */
export class Core extends EventEmitter<{
  change: [run: Run];
  report: [runId: string, stage: StageName, report: StageReport];
}> {
  private readonly records = new Map<string, RunRecord>();
  private readonly store: RunStore;
  constructor(store: RunStore) {
    super();
    this.store = store;
    for (const record of store.load()) this.records.set(record.run.id, record);
  }

  create(issue: Issue): Run {
    const existing = this.findByIssue(issue.repo, issue.number);
    if (existing) return existing;
    const now = new Date().toISOString();
    const run: Run = {
      id: randomUUID(),
      repo: issue.repo,
      issueNumber: issue.number,
      issueUrl: issue.url,
      title: issue.title,
      branch: branchName(issue.number, issue.title),
      baseBranch: null,
      worktreePath: null,
      workspaceId: null,
      status: 'queued',
      statusReason: null,
      stages: [],
      plan: { steps: [] },
      attachments: [],
      prUrl: null,
      prState: null,
      approval: null,
      policy: null,
      merge: null,
      createdAt: now,
      updatedAt: now,
    };
    const record: RunRecord = { run, operations: {} };
    this.records.set(run.id, record);
    this.commit(record);
    return structuredClone(run);
  }

  /** The newest run for an issue, whatever its state. */
  findByIssue(repo: string, issueNumber: number): Run | undefined {
    const runs = [...this.records.values()]
      .map(({ run }) => run)
      .filter((run) => run.repo === repo && run.issueNumber === issueNumber)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return runs[0] && structuredClone(runs[0]);
  }

  list(): RunSummary[] {
    return [...this.records.values()]
      .map(({ run }) => {
        const { plan: _plan, attachments: _attachments, ...summary } = run;
        return structuredClone(summary);
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): Run {
    return structuredClone(this.record(id).run);
  }

  /** Applies a change, persists it and notifies listeners. The only way run state is written. */
  update(id: string, change: (run: Run) => void): Run {
    const record = this.record(id);
    change(record.run);
    this.commit(record);
    return structuredClone(record.run);
  }

  remove(id: string): void {
    this.record(id);
    this.records.delete(id);
    this.store.remove(id);
  }

  createAttachment(runId: string, stage: string, operationId: string, input: unknown): Attachment {
    const name = parse(stageSchema, stage);
    const attachment = parse(attachmentSchema, input);
    return this.operation(runId, name, operationId, { kind: 'attachment', attachment }, (run) => {
      const value: Attachment = {
        ...attachment,
        id: randomUUID(),
        stage: name,
        createdAt: new Date().toISOString(),
      };
      run.attachments.push(value);
      return value;
    });
  }

  /** Adds an attachment written by the server itself, such as a human's approval or override. */
  note(runId: string, stage: StageName, input: AttachmentInput): Attachment {
    const value: Attachment = {
      ...input,
      id: randomUUID(),
      stage,
      createdAt: new Date().toISOString(),
    };
    this.update(runId, (run) => {
      run.attachments.push(value);
    });
    return value;
  }

  reportStatus(runId: string, stage: string, operationId: string, input: unknown): ReportReceipt {
    const name = parse(stageSchema, stage);
    const report = parse(reportSchema, input) as StageReport;
    let applied = false;
    const receipt = this.operation(runId, name, operationId, { kind: 'report', report }, (run) => {
      applied = true;
      if (report.plan) run.plan = structuredClone(report.plan);
      const current = activeStage(run);
      if (current) current.summary = report.summary;
      return { runId, stage: name, operationId, receivedAt: new Date().toISOString() };
    });
    if (applied) this.emit('report', runId, name, report);
    return receipt;
  }

  private record(id: string): RunRecord {
    parse(idSchema, id);
    const record = this.records.get(id);
    if (!record) throw new FactoryError('Run not found.', 404);
    return record;
  }

  private commit(record: RunRecord): void {
    record.run.updatedAt = new Date().toISOString();
    this.store.save(record);
    this.emit('change', structuredClone(record.run));
  }

  private operation<T>(
    runId: string,
    stage: StageName,
    operationId: string,
    input: unknown,
    apply: (run: Run) => T,
  ): T {
    parse(idSchema, operationId);
    const record = this.record(runId);
    const key = `${stage}:${operationId}`;
    const hash = fingerprint(input);
    const existing = record.operations[key];
    if (existing) {
      if (existing.hash !== hash)
        throw new FactoryError(
          'Operation ID was reused with different content.',
          409,
          'IDEMPOTENCY_CONFLICT',
        );
      return structuredClone(existing.result as T);
    }
    const current = activeStage(record.run);
    if (record.run.status !== 'running' || current?.name !== stage)
      throw new FactoryError('This stage is not running.', 409, 'RUN_STATE_CONFLICT', {
        runStatus: record.run.status,
        activeStage: current?.name ?? null,
      });
    const result = apply(record.run);
    record.operations[key] = { hash, result: structuredClone(result) };
    this.commit(record);
    return structuredClone(result);
  }
}
