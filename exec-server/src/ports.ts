import type { Provider, TaskInput } from './shared/types.ts';

export interface RuntimeCommand {
  commandId: string;
  threadId: string;
  taskId: string;
  kind: 'launch';
  task: TaskInput;
  message: string;
}

export interface PreparedCommand {
  method: string;
  payload: Record<string, unknown>;
}

export class RuntimeNotFoundError extends Error {
  constructor() {
    super('The runtime resource was not found.');
    this.name = 'RuntimeNotFoundError';
  }
}

export class RuntimeCommandError extends Error {
  readonly outcome: 'rejected' | 'unknown';

  constructor(message: string, outcome: 'rejected' | 'unknown') {
    super(message);
    this.name = 'RuntimeCommandError';
    this.outcome = outcome;
  }
}

export interface RuntimePort {
  discover(): Promise<{ providers: Provider[]; taskWorkspaceRoot?: string }>;
  prepare(command: RuntimeCommand): Promise<PreparedCommand>;
  deliver(command: PreparedCommand): Promise<void>;
  reconcile(command: PreparedCommand): Promise<boolean>;
  getSessionUrl(threadId: string, baseUrl: string): string | null;
  close(): void;
}
