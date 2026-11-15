import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { Agent, Submission, Task } from './types';
import { errorText, taskPath, wasRejected, type Api } from './api';
import { Modal } from './components';

const lines = (value: string) =>
  value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

function jiraIssue(value: string): { url: string; key: string } | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.href.length > 2000)
      return null;
    const key =
      url.pathname.match(/(?:^|\/)([A-Za-z][A-Za-z0-9_]*-\d+)(?:\/|$)/)?.[1] ??
      url.searchParams.get('selectedIssue')?.match(/^[A-Za-z][A-Za-z0-9_]*-\d+$/)?.[0];
    return key && key.length <= 200 ? { url: url.href, key: key.toUpperCase() } : null;
  } catch {
    return null;
  }
}

export function CreateTask({
  agents,
  api,
  onClose,
  onAccepted,
  onCreated,
  onAccess,
}: {
  agents: Agent[];
  api: Api;
  onClose: () => void;
  onAccepted: (task: Task) => void;
  onCreated: (task: Task) => void;
  onAccess: () => void;
}) {
  const [mode, setMode] = useState<'jira' | 'manual'>('jira');
  const [jiraUrl, setJiraUrl] = useState('');
  const [jiraInstructions, setJiraInstructions] = useState('');
  const [title, setTitle] = useState('');
  const [instructions, setInstructions] = useState('');
  const [executor, setExecutor] = useState(agents[0]?.id ?? '');
  const [criteria, setCriteria] = useState('');
  const [labels, setLabels] = useState('');
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState('');
  const [accepted, setAccepted] = useState<Task | null>(null);
  const attempt = useRef<{ id: string; submission: Submission; start: boolean } | null>(null);
  const jiraTab = useRef<HTMLButtonElement>(null);
  const manualTab = useRef<HTMLButtonElement>(null);

  function selectTab(next: 'jira' | 'manual') {
    setMode(next);
    setError('');
  }

  function tabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? 'jira'
        : event.key === 'End'
          ? 'manual'
          : mode === 'jira'
            ? 'manual'
            : 'jira';
    selectTab(next);
    (next === 'jira' ? jiraTab : manualTab).current?.focus();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (!attempt.current) {
      const issue = mode === 'jira' ? jiraIssue(jiraUrl) : null;
      if (mode === 'jira' && !issue) {
        setError('Enter an HTTPS Jira issue URL containing an issue key, such as PROJ-447.');
        return;
      }
      const acceptanceCriteria = mode === 'manual' ? lines(criteria) : [];
      const taskLabels = (mode === 'manual' ? labels : '')
        .split(',')
        .map((label) => label.trim())
        .filter(Boolean);
      if (
        acceptanceCriteria.length > 50 ||
        acceptanceCriteria.some((item) => item.length > 2000) ||
        taskLabels.length > 50 ||
        taskLabels.some((item) => item.length > 100)
      ) {
        setError(
          'Use up to 50 acceptance criteria (2,000 characters each) and 50 labels (100 characters each).',
        );
        return;
      }
      const taskInstructions = issue
        ? [
            `Fetch the Jira issue at ${JSON.stringify(issue.url)} using the Rovo/Atlassian Jira tools through MCP Catalog. Read its details and acceptance criteria, then carry out the requested work using the existing build workflow. Respect explicit task constraints and report a blocker if the ticket cannot be accessed.`,
            jiraInstructions.trim()
              ? `Additional user instructions:\n${jiraInstructions.trim()}`
              : '',
          ]
            .filter(Boolean)
            .join('\n\n')
        : instructions.trim();
      if (taskInstructions.length > 20000) {
        setError(
          'Shorten the instructions: the complete task instructions must fit within 20,000 characters.',
        );
        return;
      }
      attempt.current = {
        id: crypto.randomUUID(),
        submission: {
          title: issue ? issue.key : title.trim(),
          input: {
            instructions: taskInstructions,
          },
          executor,
          acceptanceCriteria,
          labels: taskLabels,
        },
        start:
          mode === 'jira' ||
          (event.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'start',
      };
    }
    const current = attempt.current;
    setLocked(true);
    setBusy(true);
    setError('');
    let saved = accepted;
    try {
      if (!saved) {
        saved = await api<Task>(taskPath(current.id), 'PUT', current.submission);
        setAccepted(saved);
        onAccepted(saved);
      }
      if (current.start && accepted) saved = await api<Task>(taskPath(current.id));
      if (current.start && ['pending', 'unknown'].includes(saved.setup.status))
        saved = await api<Task>(`${taskPath(current.id)}/start`, 'POST', {});
      onCreated(saved);
    } catch (cause) {
      setError(saved ? `Task saved. Starting it failed: ${errorText(cause)}` : errorText(cause));
      if (!saved && wasRejected(cause)) {
        attempt.current = null;
        setLocked(false);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Create task"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <p className="muted">Start from a Jira issue or provide the task details yourself.</p>
      <form onSubmit={(event) => void submit(event)}>
        <fieldset className="form-fields" disabled={busy || locked}>
          <div className="task-tabs" role="tablist" aria-label="Task input">
            <button
              ref={jiraTab}
              type="button"
              role="tab"
              id="create-task-jira-tab"
              aria-controls="create-task-jira-panel"
              aria-selected={mode === 'jira'}
              tabIndex={mode === 'jira' ? 0 : -1}
              onClick={() => selectTab('jira')}
              onKeyDown={tabKeyDown}
            >
              Jira link
            </button>
            <button
              ref={manualTab}
              type="button"
              role="tab"
              id="create-task-manual-tab"
              aria-controls="create-task-manual-panel"
              aria-selected={mode === 'manual'}
              tabIndex={mode === 'manual' ? 0 : -1}
              onClick={() => selectTab('manual')}
              onKeyDown={tabKeyDown}
            >
              Task details
            </button>
          </div>
          <div
            role="tabpanel"
            id="create-task-jira-panel"
            aria-labelledby="create-task-jira-tab"
            hidden={mode !== 'jira'}
          >
            {mode === 'jira' && (
              <>
                <label>
                  Jira issue URL
                  <input
                    autoFocus
                    type="url"
                    required
                    maxLength={2000}
                    placeholder="https://example.atlassian.net/browse/PROJ-447"
                    value={jiraUrl}
                    onChange={(event) => setJiraUrl(event.target.value)}
                  />
                </label>
                <p className="muted small">The agent will fetch the issue and start the task.</p>
                <label>
                  Additional instructions <span className="muted">(optional)</span>
                  <textarea
                    rows={5}
                    maxLength={20000}
                    placeholder="Add guidance for the agent alongside the Jira ticket details."
                    value={jiraInstructions}
                    onChange={(event) => setJiraInstructions(event.target.value)}
                  />
                </label>
              </>
            )}
          </div>
          <div
            role="tabpanel"
            id="create-task-manual-panel"
            aria-labelledby="create-task-manual-tab"
            hidden={mode !== 'manual'}
          >
            {mode === 'manual' && (
              <>
                <label>
                  Title
                  <input
                    required
                    maxLength={200}
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                  />
                </label>
                <label>
                  Initial instructions
                  <textarea
                    required
                    rows={5}
                    maxLength={20000}
                    value={instructions}
                    onChange={(event) => setInstructions(event.target.value)}
                  />
                </label>
                <label>
                  Acceptance criteria <span className="muted">(one per line, optional)</span>
                  <textarea
                    rows={3}
                    value={criteria}
                    onChange={(event) => setCriteria(event.target.value)}
                  />
                </label>
                <label>
                  Labels <span className="muted">(comma separated, optional)</span>
                  <input value={labels} onChange={(event) => setLabels(event.target.value)} />
                </label>
              </>
            )}
          </div>
          <label>
            Executor
            <select required value={executor} onChange={(event) => setExecutor(event.target.value)}>
              {!agents.length && <option value="">No executors available</option>}
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </label>
        </fieldset>
        {error && (
          <div className="error" role="alert">
            <p>{error}</p>
            <button type="button" className="text-button" onClick={onAccess}>
              API access
            </button>
          </div>
        )}
        {locked && error && (
          <p className="muted retry-help">
            Retry uses the same task ID and definition to avoid duplicate work.
          </p>
        )}
        <div className="form-actions">
          {accepted ? (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => onCreated(accepted)}
            >
              Open saved task
            </button>
          ) : (
            <button type="button" className="secondary" disabled={busy} onClick={onClose}>
              Cancel
            </button>
          )}
          {locked ? (
            <button type="submit" disabled={busy}>
              {busy ? 'Submitting…' : accepted ? 'Check setup' : 'Retry submission'}
            </button>
          ) : (
            <>
              {mode === 'manual' && (
                <button
                  type="submit"
                  value="pending"
                  className="secondary"
                  disabled={
                    !title.trim() || title.trim().length > 200 || !executor || !instructions.trim()
                  }
                >
                  Save task
                </button>
              )}
              <button
                type="submit"
                value="start"
                disabled={
                  !executor ||
                  (mode === 'jira'
                    ? !jiraUrl.trim()
                    : !title.trim() || title.trim().length > 200 || !instructions.trim())
                }
              >
                Submit and start
              </button>
            </>
          )}
        </div>
      </form>
    </Modal>
  );
}
