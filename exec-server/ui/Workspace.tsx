import { useState } from 'react';
import type { Agent, Attachment, Task } from './types';
import { errorText, taskPath, type Api } from './api';
import { DateLabel, Markdown, PlanProgress, Status } from './components';
import { Attachments } from './Attachments';
import { AttachmentPreview } from './AttachmentPreview';
import { OpenCodeConnect } from './OpenCodeConnect';

const setupDescriptions: Record<Task['setup']['status'], string> = {
  pending:
    'Start the task to create its OpenCode session and submit the initial instructions once.',
  starting: 'The OpenCode session and initial instruction submission are being set up.',
  submitted: 'Initial instructions were submitted. Agent reports appear separately.',
  unknown:
    'Instruction delivery is uncertain. Check submission looks for the original submission without resending instructions.',
  failed: 'Setup failed. This is separate from an agent-reported failure.',
};

export function Workspace({
  task,
  agents,
  api,
  onUpdate,
}: {
  task: Task;
  agents: Agent[];
  api: Api;
  onUpdate: (task: Task) => void;
}) {
  const [action, setAction] = useState('');
  const [error, setError] = useState('');
  const [attachmentId, setAttachmentId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const canStart = ['pending', 'unknown'].includes(task.setup.status);
  const canArchive = !task.archivedAt;
  const openAttachment = (item: Attachment) => {
    setAttachmentId(item.id);
  };
  const executor = agents.find((agent) => agent.id === task.executor);
  async function run(command: 'start' | 'archive') {
    if (action || (command === 'start' && !canStart) || (command === 'archive' && !canArchive))
      return;
    setAction(command);
    setError('');
    try {
      onUpdate(await api<Task>(`${taskPath(task.id)}/${command}`, 'POST', {}));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setAction('');
    }
  }
  return (
    <>
      <a className="text-button breadcrumb" href="#/">
        ← All tasks
      </a>
      <header className="workspace-heading">
        <div>
          <p className="eyebrow">{executor?.name ?? task.executor} / Task workspace</p>
          <h1>{task.title}</h1>
          <div className="status-row">
            <Status value={task.setup.status} label={`Setup: ${task.setup.status}`} />
            {task.report && (
              <Status
                value={task.report.status}
                label={`Agent: ${task.report.status.replaceAll('_', ' ')}`}
              />
            )}
            {task.archivedAt && <Status value="archived" />}
            <span className="muted">
              Updated <DateLabel date={task.updatedAt} />
            </span>
          </div>
        </div>
        <div className="actions">
          {task.runtimeUrl && (
            <button className="text-button" onClick={() => setConnecting(true)}>
              Open in OpenCode
            </button>
          )}
          {canStart && (
            <button disabled={!!action} onClick={() => void run('start')}>
              {action === 'start'
                ? 'Checking setup…'
                : task.setup.status === 'unknown'
                  ? 'Check submission'
                  : 'Start task'}
            </button>
          )}
          {canArchive && (
            <button className="secondary" disabled={!!action} onClick={() => void run('archive')}>
              {action === 'archive' ? 'Archiving…' : 'Archive task'}
            </button>
          )}
        </div>
      </header>
      {error && (
        <p className="error-notice" role="alert">
          {error}
        </p>
      )}
      {task.report?.status === 'input_required' && (
        <section className="notice" role="status">
          <h2>Agent reported input required</h2>
          <p>Open the task’s OpenCode session to review questions and permission requests.</p>
          {task.runtimeUrl ? (
            <button className="text-button" onClick={() => setConnecting(true)}>
              Continue in OpenCode →
            </button>
          ) : (
            <p className="muted">The OpenCode session link is not available yet.</p>
          )}
        </section>
      )}
      <div className="workspace-grid">
        <div className="workspace-main">
          <section className="panel">
            <h2>Latest agent report</h2>
            <p className="muted">
              Agent-reported state does not confirm runtime activity. Later reports may update any
              state; OpenCode activity alone does not change this report.
            </p>
            {task.report ? (
              <>
                <p className="muted attachment-meta">
                  Received <DateLabel date={task.report.receivedAt} />
                </p>
                <Markdown text={task.report.summary} />
              </>
            ) : (
              <p className="muted empty-copy">No agent report received yet.</p>
            )}
          </section>
          <section className="panel">
            <div className="section-heading">
              <h2>Latest reported plan</h2>
              <span className="muted">
                {task.plan.steps.filter((step) => step.status === 'completed').length}/
                {task.plan.steps.length} done
              </span>
            </div>
            <PlanProgress plan={task.plan} title={task.title} />
          </section>
          <section className="panel">
            <h2>Initial instructions</h2>
            <Markdown text={task.input.instructions} />
          </section>
          {task.acceptanceCriteria.length > 0 && (
            <section className="panel">
              <h2>Acceptance criteria</h2>
              <ul className="criteria-list">
                {task.acceptanceCriteria.map((criterion, index) => (
                  <li key={index}>{criterion}</li>
                ))}
              </ul>
            </section>
          )}
          <Attachments attachments={task.attachments} onOpen={openAttachment} />
        </div>
        <aside className="workspace-aside">
          <section className="panel">
            <h2>Task setup</h2>
            <Status value={task.setup.status} label={`Setup: ${task.setup.status}`} />
            <p className="muted empty-copy">{setupDescriptions[task.setup.status]}</p>
            {task.setup.error && (
              <p className="error" role="alert">
                {task.setup.error.message}
              </p>
            )}
            <p className="muted empty-copy">Archiving only changes how this task is displayed.</p>
          </section>
          <section className="panel">
            <h2>Task details</h2>
            <dl className="details-list">
              <dt>Task ID</dt>
              <dd className="path">{task.id}</dd>
              <dt>Executor</dt>
              <dd>{executor?.name ?? task.executor}</dd>
              <dt>Created</dt>
              <dd>
                <DateLabel date={task.createdAt} />
              </dd>
              {task.archivedAt && (
                <>
                  <dt>Archived</dt>
                  <dd>
                    <DateLabel date={task.archivedAt} />
                  </dd>
                </>
              )}
              <dt>Labels</dt>
              <dd>
                {task.labels.length ? (
                  <div className="status-row">
                    {task.labels.map((label, index) => (
                      <span key={index} className="label-badge">
                        {label}
                      </span>
                    ))}
                  </div>
                ) : (
                  'None'
                )}
              </dd>
            </dl>
          </section>
          {executor && (
            <section className="panel">
              <h2>Executor</h2>
              <p className="muted">{executor.description}</p>
              <div className="capabilities">
                {executor.capabilities.map((capability) => (
                  <span className="label-badge" key={capability}>
                    {capability}
                  </span>
                ))}
              </div>
            </section>
          )}
        </aside>
      </div>
      {connecting && task.runtimeUrl && (
        <OpenCodeConnect
          api={api}
          sessionUrl={task.runtimeUrl}
          onClose={() => setConnecting(false)}
        />
      )}
      {task.attachments
        .filter((attachment) => attachment.id === attachmentId)
        .map((attachment) => (
          <AttachmentPreview
            key={attachment.id}
            attachment={attachment}
            onClose={() => setAttachmentId(null)}
          />
        ))}
    </>
  );
}
