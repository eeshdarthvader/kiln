export type {
  Attachment,
  Plan,
  Run,
  RunStatus,
  RunSummary,
  StageName,
  StageRecord,
} from '../src/domain.ts';

export interface FactoryInfo {
  repos: string[];
  label: string;
  pollSeconds: number;
  maxRuns: number;
  herdrSession: string;
  lastPollAt: string | null;
  lastError: string | null;
}
