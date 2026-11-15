import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { Provider } from './shared/types.ts';

export class SawdError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;
  constructor(message: string, status = 400, code?: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'SawdError';
    this.status = status;
    this.code =
      code ??
      (
        {
          400: 'VALIDATION_FAILED',
          401: 'UNAUTHORIZED',
          404: 'TASK_NOT_FOUND',
          409: 'TASK_STATE_CONFLICT',
          413: 'PAYLOAD_TOO_LARGE',
          415: 'UNSUPPORTED_MEDIA_TYPE',
          500: 'INTERNAL_ERROR',
          502: 'UPSTREAM_ERROR',
          503: 'NOT_READY',
        } as Record<number, string>
      )[status] ??
      'INTERNAL_ERROR';
    this.details = details;
  }
}
export type Capability = 'git' | 'docker' | 'node' | 'python';
export type Status = 'running' | 'input_required' | 'done' | 'failed';
export interface TaskSetup {
  status: 'pending' | 'starting' | 'submitted' | 'failed' | 'unknown';
  error?: { code: 'SETUP_FAILED' | 'DELIVERY_UNKNOWN'; message: string };
}
export interface TaskReport {
  status: Status;
  summary: string;
  receivedAt: string;
}
export interface AgentProfile {
  id: string;
  name: string;
  description: string;
  capabilities: Capability[];
  provider: string;
  instanceId: string;
  model: string;
  workspaceRoot: string;
}
export function profiles(
  providers: Provider[],
  root: string | undefined,
  capabilities: Capability[],
): AgentProfile[] {
  if (!root || !isAbsolute(root))
    throw new SawdError('An absolute runtime workspace root is required.');
  return providers.flatMap((provider) =>
    provider.driver === 'opencode' && provider.available
      ? provider.models.map((model) => ({
          id: `opencode-${fingerprint([provider.id, model.id]).slice(0, 24)}`,
          name: `${provider.name} · ${model.name}`,
          description: `${provider.name} executor using ${model.name}.`,
          capabilities: [...capabilities],
          provider: provider.driver,
          instanceId: provider.id,
          model: model.id,
          workspaceRoot: root,
        }))
      : [],
  );
}
export type AttachmentInput =
  | { kind: 'decision'; title: string; summary: string; rationale: string }
  | { kind: 'artifact'; title: string; content: string; mediaType: 'text/markdown' | 'text/plain' }
  | { kind: 'evidence'; title: string; text?: string; url?: string }
  | { kind: 'context_reference'; title: string; url: string; description?: string };
export type Attachment = AttachmentInput & { id: string; createdAt: string };
export interface TaskDefinition {
  title: string;
  acceptanceCriteria: string[];
  labels: string[];
  executor: string;
}
export interface Submission extends TaskDefinition {
  input: { instructions: string };
}
export interface PlanStep {
  id: string;
  text: string;
  status: 'pending' | 'running' | 'completed';
}
export interface Plan {
  steps: PlanStep[];
}
export interface Task extends TaskDefinition {
  id: string;
  setup: TaskSetup;
  report: TaskReport | null;
  archivedAt: string | null;
  runtimeUrl: string | null;
  plan: Plan;
  attachments: Attachment[];
  input: { instructions: string };
  createdAt: string;
  updatedAt: string;
}
export type TaskSummary = Omit<Task, 'input' | 'acceptanceCriteria' | 'plan' | 'attachments'>;
export interface ReportReceipt {
  taskId: string;
  operationId: string;
  receivedAt: string;
}
export interface TaskRecord {
  task: Task;
  submissionHash: string;
  threadId: string;
  workspacePath: string;
  operations: Map<string, { hash: string; result: unknown }>;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
export const fingerprint = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
