import { isAbsolute, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  RuntimeCommandError,
  RuntimeNotFoundError,
  type PreparedCommand,
  type RuntimeCommand,
  type RuntimePort,
} from '../ports.ts';
import { reportingServerName } from '../reporting-instructions.ts';
import { data, dataList, discovery, identifier, object, text, wireMessageId } from './wire.ts';
import { provisionDirectory } from './workspace.ts';
import { OpenCodeTransport } from './transport.ts';

type Model = { providerID: string; id: string };
type Session = { id: string; directory: string };

/** Initial-launch adapter for the pinned OpenCode 2.2.7 REST API. */
export class OpenCodeClient implements RuntimePort {
  private readonly transport: OpenCodeTransport;
  private readonly workspaceRoot: string;
  private readonly sessions = new Map<string, Session>();
  private readonly prepared = new Map<string, PreparedCommand>();
  private readonly attempted = new Set<string>();
  private readonly delivered = new Set<string>();
  private reportingUrl?: string;

  constructor(options: { url: string; password?: string; workspaceRoot: string }) {
    if (!isAbsolute(options.workspaceRoot))
      throw new Error('An absolute OpenCode workspace root is required.');
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.transport = new OpenCodeTransport(options);
  }

  async discover() {
    let response: [unknown, unknown] | undefined;
    // Discovery is read-only; transient failures are safe to retry before task setup.
    for (const [attempt, waitMs] of [0, 250, 500].entries()) {
      if (waitMs) await delay(waitMs);
      try {
        response = await Promise.all([
          this.transport.request('/api/provider', this.workspaceRoot),
          this.transport.request('/api/model', this.workspaceRoot),
        ]);
        break;
      } catch (error) {
        if (!(error instanceof RuntimeCommandError) || error.outcome !== 'unknown' || attempt === 2)
          throw error;
      }
    }
    return {
      providers: discovery(response?.[0], response?.[1]),
      taskWorkspaceRoot: this.workspaceRoot,
    };
  }

  async registerReporting(url: string): Promise<void> {
    this.reportingUrl = url.replace(/\/+$/, '');
    await this.registerDirectory(this.workspaceRoot, this.reportingUrl);
  }

  async prepare(command: RuntimeCommand): Promise<PreparedCommand> {
    const cached = this.prepared.get(command.commandId);
    if (cached) return structuredClone(cached);
    const { threadId, commandId, taskId, task } = command;
    const directory = await provisionDirectory(this.workspaceRoot, task.workspacePath);
    await this.registerDirectory(
      directory,
      this.reportingUrl ? `${this.reportingUrl}/tasks/${encodeURIComponent(taskId)}` : undefined,
    );
    const model = { providerID: task.modelSelection.instanceId, id: task.modelSelection.model };
    let session = this.sessions.get(threadId);
    if (!session) {
      const matching = await this.findSessions(directory, threadId);
      if (matching.length > 1)
        throw new RuntimeCommandError(
          'Multiple OpenCode sessions match this task. Inspect the runtime.',
          'rejected',
        );
      const info =
        matching[0] ??
        data(
          await this.transport.request('/api/session', undefined, 'POST', {
            title: task.title,
            location: { directory },
            model,
            metadata: { sawdThreadId: threadId },
          }),
        );
      if (object(info.location).directory !== directory || info.parentID !== undefined)
        throw new RuntimeCommandError(
          'OpenCode returned an invalid task root session.',
          'rejected',
        );
      const id = identifier(info.id, 'ses');
      if (matching.length && !sameModel(info.model, model)) await this.selectModel(id, model);
      session = { id, directory };
      this.sessions.set(threadId, session);
    }
    const prepared = {
      method: 'prompt',
      payload: {
        commandId,
        threadId,
        ...session,
        messageID: wireMessageId(commandId),
        message: command.message,
      },
    };
    this.prepared.set(commandId, prepared);
    return structuredClone(prepared);
  }

  async deliver(command: PreparedCommand): Promise<void> {
    const payload = command.payload;
    const commandId = text(payload.commandId);
    if (this.delivered.has(commandId)) return;
    if (command.method !== 'prompt')
      throw new RuntimeCommandError('Unsupported prepared OpenCode command.', 'rejected');
    try {
      if (await this.reconcile(command)) return;
    } catch (error) {
      if (this.attempted.has(commandId)) throw unknownDelivery();
      throw error;
    }
    // Keep uncertain deliveries read-only even though V2 supports same-ID admission.
    if (this.attempted.has(commandId)) throw unknownDelivery();
    this.attempted.add(commandId);
    const result = await this.transport.request(
      `/api/session/${encodeURIComponent(identifier(payload.id, 'ses'))}/prompt`,
      undefined,
      'POST',
      {
        id: identifier(payload.messageID, 'msg_'),
        text: text(payload.message),
      },
    );
    try {
      const admitted = data(result);
      if (
        admitted.id !== payload.messageID ||
        admitted.sessionID !== payload.id ||
        admitted.type !== 'user' ||
        object(admitted.payload).text !== payload.message
      )
        throw unknownDelivery();
    } catch {
      throw unknownDelivery();
    }
    this.delivered.add(commandId);
  }

  async reconcile(command: PreparedCommand): Promise<boolean> {
    const payload = command.payload;
    const commandId = text(payload.commandId);
    if (this.delivered.has(commandId)) return true;
    const sessionId = identifier(payload.id, 'ses');
    const messageId = identifier(payload.messageID, 'msg_');
    const path = `/api/session/${encodeURIComponent(sessionId)}`;
    // Check pending input before projected messages so promotion cannot fall between the reads.
    const pending = dataList(await this.transport.request(`${path}/inbox`)).find(
      (item) => item.id === messageId,
    );
    if (pending) {
      if (
        pending.sessionID !== sessionId ||
        pending.type !== 'user' ||
        object(pending.payload).text !== payload.message
      )
        throw unknownDelivery();
    } else {
      let message;
      try {
        message = data(
          await this.transport.request(`${path}/message/${encodeURIComponent(messageId)}`),
        );
      } catch (error) {
        if (error instanceof RuntimeNotFoundError) return false;
        throw error;
      }
      if (message.id !== messageId || message.type !== 'user' || message.text !== payload.message)
        throw unknownDelivery();
    }
    this.delivered.add(commandId);
    return true;
  }

  getSessionUrl(threadId: string, baseUrl: string): string | null {
    const session = this.sessions.get(threadId);
    if (!session) return null;
    const server = Buffer.from(baseUrl.replace(/\/+$/, '')).toString('base64url');
    return new URL(
      `server/${server}/session/${encodeURIComponent(session.id)}`,
      `${baseUrl.replace(/\/$/, '')}/`,
    ).href;
  }

  close(): void {
    this.transport.close();
  }

  private async registerDirectory(directory: string, url?: string): Promise<void> {
    if (!url) return;
    await this.transport.request(
      `/api/experimental/mcp/${encodeURIComponent(reportingServerName)}`,
      directory,
      'PUT',
      { config: { type: 'remote', url, oauth: false, disabled: false } },
    );
    // V2 acknowledges registration before each location's connection has settled.
    for (const waitMs of [0, 100, 250, 500, 1_000, 2_000]) {
      if (waitMs) await delay(waitMs);
      const server = dataList(await this.transport.request('/api/mcp', directory)).find(
        (candidate) => candidate.name === reportingServerName,
      );
      const status = server && object(server.status).status;
      if (status === 'connected') return;
      if (status !== 'pending') break;
    }
    throw new Error('OpenCode could not connect to the sawd reporting MCP server.');
  }

  private async findSessions(directory: string, threadId: string) {
    const matching = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = object(
        await this.transport.request('/api/session', undefined, 'GET', undefined, {
          directory,
          parentID: 'null',
          ...(cursor ? { cursor } : {}),
        }),
      );
      matching.push(
        ...dataList(page).filter(
          (candidate) =>
            object(candidate.location).directory === directory &&
            candidate.metadata !== undefined &&
            object(candidate.metadata).sawdThreadId === threadId,
        ),
      );
      const next = object(page.cursor).next;
      cursor = next === undefined || next === null ? undefined : text(next);
      if (cursor && cursors.has(cursor)) throw new Error('OpenCode repeated a session cursor.');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return matching;
  }

  private async selectModel(sessionId: string, model: Model): Promise<void> {
    await this.transport.request(
      `/api/session/${encodeURIComponent(sessionId)}/model`,
      undefined,
      'POST',
      { model },
    );
  }
}

function sameModel(value: unknown, model: Model): boolean {
  if (value === undefined) return false;
  const current = object(value);
  return (
    current.providerID === model.providerID &&
    current.id === model.id &&
    (current.variant ?? 'default') === 'default'
  );
}

function unknownDelivery(): RuntimeCommandError {
  return new RuntimeCommandError(
    'OpenCode initial prompt acceptance is unknown. Inspect the runtime.',
    'unknown',
  );
}
