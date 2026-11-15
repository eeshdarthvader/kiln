import type { AgentProfile } from '../src/domain.ts';

export type Agent = Pick<AgentProfile, 'id' | 'name' | 'description' | 'capabilities'>;
export type { Attachment, Plan, Status, Submission, Task, TaskSummary } from '../src/domain.ts';
