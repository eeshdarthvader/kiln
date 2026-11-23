import { createHash } from 'node:crypto';

export class FactoryError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;
  constructor(message: string, status = 400, code?: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'FactoryError';
    this.status = status;
    this.code =
      code ??
      (
        {
          400: 'VALIDATION_FAILED',
          401: 'UNAUTHORIZED',
          404: 'RUN_NOT_FOUND',
          409: 'RUN_STATE_CONFLICT',
          413: 'PAYLOAD_TOO_LARGE',
          500: 'INTERNAL_ERROR',
          502: 'UPSTREAM_ERROR',
          503: 'NOT_READY',
        } as Record<number, string>
      )[status] ??
      'INTERNAL_ERROR';
    this.details = details;
  }
}

/** Pipeline order. Review stages can send the run back to the stage before them. */
export const stageNames = ['classify', 'plan', 'plan-review', 'implement', 'review', 'pr'] as const;
/** `resolve` is not part of the sequence: it runs when a branch conflicts with its base. */
export type StageName = (typeof stageNames)[number] | 'resolve';

export type RunStatus = 'queued' | 'running' | 'needs_input' | 'done' | 'failed' | 'cancelled';
export type StageStatus = 'running' | 'done' | 'changes_requested' | 'needs_input' | 'failed';
export type ReportStatus = 'running' | 'input_required' | 'done' | 'failed';
export type Verdict = 'pass' | 'changes_requested';
/** A reviewer's read of how much a change alters existing behaviour. */
export type Risk = 'low' | 'high';
export type PrState = 'draft' | 'open' | 'merged' | 'closed';

export interface StageRecord {
  name: StageName;
  /** 1-based count of how many times this stage has run in this run. */
  attempt: number;
  status: StageStatus;
  paneId: string | null;
  summary: string;
  startedAt: string;
  endedAt: string | null;
}

export interface PlanStep {
  id: string;
  text: string;
  status: 'pending' | 'running' | 'completed';
}
export interface Plan {
  steps: PlanStep[];
}

export type Reversibility = 'cheap' | 'costly' | 'one_way';
export type Autonomy = 'L0' | 'L1' | 'L2' | 'L3';
export const autonomyLevels = ['L0', 'L1', 'L2', 'L3'] as const satisfies readonly Autonomy[];

export type AttachmentInput =
  | {
      kind: 'decision';
      title: string;
      summary: string;
      rationale: string;
      /** The alternatives that were considered. */
      options?: string[];
      /** How hard the decision is to undo. `one_way` always needs a human at autonomy L2. */
      reversibility?: Reversibility;
      /** What the decision touches: modules, services or users. */
      blastRadius?: string;
    }
  | { kind: 'artifact'; title: string; content: string; mediaType: 'text/markdown' | 'text/plain' }
  | { kind: 'evidence'; title: string; text?: string; url?: string }
  | { kind: 'context_reference'; title: string; url: string; description?: string };
export type Attachment = AttachmentInput & { id: string; stage: StageName; createdAt: string };

export interface Issue {
  /** `owner/name`. */
  repo: string;
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
  state: 'open' | 'closed';
}

/** A human decision the run is waiting for, raised by the autonomy policy. */
export interface Approval {
  /** The stage that just finished; the run continues after it once approved. */
  after: StageName;
  reasons: string[];
  requestedAt: string;
}

/** What the autonomy policy decided for a run. */
export interface PolicyResult {
  autonomy: Autonomy;
  /** Why the change counts as critical. Empty when no rule matched. */
  critical: string[];
  /** A human approved the critical change. */
  approved: boolean;
}

/** `requested`: merge or auto-merge was set up. `held`: policy kept it for a human. */
export type MergeState = 'requested' | 'held' | 'failed';

export interface Change {
  path: string;
  added: number;
  deleted: number;
}

export interface Run {
  id: string;
  repo: string;
  issueNumber: number;
  issueUrl: string;
  title: string;
  branch: string;
  baseBranch: string | null;
  worktreePath: string | null;
  workspaceId: string | null;
  status: RunStatus;
  /** Why the run stopped, for `needs_input`, `failed` and `cancelled`. */
  statusReason: string | null;
  stages: StageRecord[];
  plan: Plan;
  attachments: Attachment[];
  prUrl: string | null;
  /** The pull request's state on GitHub, refreshed while the run's PR is still open. */
  prState: PrState | null;
  approval: Approval | null;
  policy: PolicyResult | null;
  merge: MergeState | null;
  createdAt: string;
  updatedAt: string;
}
export type RunSummary = Omit<Run, 'plan' | 'attachments'>;

export interface StageReport {
  status: ReportStatus;
  summary: string;
  verdict?: Verdict;
  /** The review stage can flag a drastic logic change; `high` always needs a human at L2. */
  risk?: Risk;
  riskReason?: string;
  prUrl?: string;
  plan?: Plan;
}

export interface ReportReceipt {
  runId: string;
  stage: StageName;
  operationId: string;
  receivedAt: string;
}

export interface RunRecord {
  run: Run;
  /** Retry-safe agent writes: the same operation ID with the same payload is applied once. */
  operations: Record<string, { hash: string; result: unknown }>;
}

export const activeStage = (run: Pick<Run, 'stages'>): StageRecord | undefined =>
  run.stages.findLast((stage) => stage.status === 'running');

export const isTerminal = (status: RunStatus) =>
  status === 'done' || status === 'failed' || status === 'cancelled';

export function branchName(issueNumber: number, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return `factory/${issueNumber}${slug ? `-${slug}` : ''}`;
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
