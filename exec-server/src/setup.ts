import type { Core } from './core.ts';
import type { Task } from './domain.ts';
import { RuntimeCommandError, type PreparedCommand, type RuntimePort } from './ports.ts';

/** Owns initial delivery only. Agent reports are the sole source of subsequent progress. */
export class TaskInitializer {
  private readonly starts = new Map<string, Promise<Task>>();
  private readonly prepared = new Map<string, PreparedCommand>();
  private readonly core: Core;
  private readonly runtime: RuntimePort;
  private readonly publicUrl: string;

  constructor(core: Core, runtime: RuntimePort, publicUrl: string) {
    this.core = core;
    this.runtime = runtime;
    this.publicUrl = publicUrl;
  }

  start(id: string): Promise<Task> {
    const pending = this.starts.get(id);
    if (pending) return pending;
    const operation = this.initialize(id);
    this.starts.set(id, operation);
    void operation
      .finally(() => {
        if (this.starts.get(id) === operation) this.starts.delete(id);
      })
      .catch(() => {});
    return operation;
  }

  private async initialize(id: string): Promise<Task> {
    const record = this.core.record(id);
    const status = record.task.setup.status;
    if (status === 'unknown') {
      const command = this.prepared.get(id);
      if (command) {
        try {
          if (await this.runtime.reconcile(structuredClone(command)))
            return this.core.setSetup(id, { status: 'submitted' });
        } catch {
          // An unsuccessful read cannot establish whether the initial prompt was accepted.
        }
      }
      return this.core.get(id);
    }
    if (status !== 'pending') return this.core.get(id);
    this.core.start(id);
    let phase: 'discovery' | 'preparation' | 'delivery' = 'discovery';
    try {
      const profile = this.core.profile(record.task.executor);
      const discovery = await this.runtime.discover();
      const provider = discovery.providers.find(
        (candidate) =>
          candidate.id === profile.instanceId &&
          candidate.driver === profile.provider &&
          candidate.available,
      );
      if (!provider?.models.some((model) => model.id === profile.model))
        throw new RuntimeCommandError('Selected provider or model is unavailable.', 'rejected');
      phase = 'preparation';
      const command = await this.runtime.prepare({
        kind: 'launch',
        commandId: `${record.threadId}:start`,
        threadId: record.threadId,
        taskId: id,
        message: this.core.initialMessage(id),
        task: {
          title: record.task.title,
          workspacePath: record.workspacePath,
          modelSelection: { instanceId: profile.instanceId, model: profile.model },
        },
      });
      this.prepared.set(id, structuredClone(command));
      this.core.setSetup(
        id,
        { status: 'starting' },
        this.runtime.getSessionUrl(record.threadId, this.publicUrl),
      );
      phase = 'delivery';
      await this.runtime.deliver(structuredClone(command));
      return this.core.setSetup(id, { status: 'submitted' });
    } catch (error) {
      const unknown =
        phase !== 'discovery' &&
        (error instanceof RuntimeCommandError ? error.outcome === 'unknown' : phase === 'delivery');
      return this.core.setSetup(id, {
        status: unknown ? 'unknown' : 'failed',
        error: {
          code: unknown ? 'DELIVERY_UNKNOWN' : 'SETUP_FAILED',
          message: unknown
            ? phase === 'preparation'
              ? 'Runtime setup outcome could not be confirmed. Initial prompt delivery was not attempted. Inspect the runtime before taking further action.'
              : 'Initial runtime delivery could not be confirmed. Inspect the runtime before taking further action.'
            : phase === 'discovery'
              ? 'OpenCode model discovery failed or the selected model is unavailable. No task session or prompt was created. Check OpenCode availability and configured models, then submit a new task.'
              : 'Runtime setup failed. Check the configured runtime and selected model.',
        },
      });
    }
  }
}
