import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Agent, Task, TaskSummary } from './types';
import { createApi, errorText, taskPath } from './api';
import { CreateTask } from './CreateTask';
import { TaskList } from './TaskList';
import { Workspace } from './Workspace';
import { DateLabel, Modal } from './components';
import './styles.css';

function selectedFromHash(): string | null {
  try {
    return window.location.hash.startsWith('#/tasks/')
      ? decodeURIComponent(window.location.hash.slice(8)) || null
      : null;
  } catch {
    return null;
  }
}

function ApiAccess({
  currentToken,
  onSave,
  onClose,
}: {
  currentToken: string;
  onSave: (token: string) => void;
  onClose: () => void;
}) {
  const [token, setToken] = useState(currentToken);
  return (
    <Modal title="API access" onClose={onClose}>
      <p className="muted">
        If this server requires SAWD_API_TOKEN, enter it here. The token stays in memory for this
        page and is cleared when you reload.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSave(token.trim());
        }}
      >
        <label>
          API token
          <input
            autoFocus
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
        </label>
        <div className="form-actions">
          <button type="button" className="secondary" onClick={() => onSave('')}>
            Clear token
          </button>
          <button type="submit">Apply token</button>
        </div>
      </form>
    </Modal>
  );
}

function App() {
  const [token, setToken] = useState('');
  const api = useMemo(() => createApi(token), [token]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [selectedId, setSelectedId] = useState(selectedFromHash);
  const [detail, setDetail] = useState<Task | null>(null);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [agentError, setAgentError] = useState('');
  const [detailError, setDetailError] = useState('');
  const [lastRefresh, setLastRefresh] = useState('');
  const [creating, setCreating] = useState(false);
  const [accessOpen, setAccessOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const revision = useRef(0);
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;

  useEffect(() => {
    const change = () => {
      const nextId = selectedFromHash();
      if (nextId === selectedRef.current) return;
      selectedRef.current = nextId;
      setSelectedId(nextId);
      setDetail(null);
      setDetailError('');
    };
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, []);

  useEffect(() => {
    let canceled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    async function refresh() {
      const currentRevision = revision.current;
      const [agentResult, taskResult, detailResult] = await Promise.allSettled([
        api<{ agents: Agent[] }>('/agents'),
        api<{ tasks: TaskSummary[] }>('/tasks'),
        selectedId ? api<Task>(taskPath(selectedId)) : Promise.resolve(null),
      ]);
      if (canceled) return;
      if (currentRevision === revision.current) {
        if (agentResult.status === 'fulfilled') {
          setAgents(agentResult.value.agents);
          setAgentError('');
        } else setAgentError(errorText(agentResult.reason));
        if (taskResult.status === 'fulfilled') {
          setTasks(taskResult.value.tasks);
          setListError('');
          setLastRefresh(new Date().toISOString());
        } else setListError(errorText(taskResult.reason));
        if (detailResult.status === 'fulfilled') {
          setDetail(detailResult.value);
          setDetailError('');
        } else setDetailError(errorText(detailResult.reason));
      }
      setLoading(false);
      timeout = setTimeout(() => void refresh(), 5000);
    }
    void refresh();
    return () => {
      canceled = true;
      clearTimeout(timeout);
    };
  }, [api, selectedId, refreshKey]);

  function update(task: Task) {
    revision.current++;
    if (selectedRef.current === task.id) setDetail(task);
    setTasks((previous) =>
      previous.some((item) => item.id === task.id)
        ? previous.map((item) => (item.id === task.id ? task : item))
        : [task, ...previous],
    );
    setRefreshKey((key) => key + 1);
  }
  function created(task: Task) {
    update(task);
    setCreating(false);
    window.location.hash = `/tasks/${encodeURIComponent(task.id)}`;
  }
  const hasRefreshError = !!(listError || agentError || detailError);
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#/">
          <span className="brand-mark" aria-hidden="true">
            sf
          </span>
          <span>
            Software
            <br />
            Factory
          </span>
        </a>
        <p className="eyebrow nav-label">Workspace</p>
        <a className="nav-item" href="#/" aria-current={!selectedId ? 'page' : undefined}>
          Tasks <span>{tasks.length}</span>
        </a>
        <div className="sidebar-bottom">
          <span className="poc-badge">SAWD reporting</span>
          <p>
            Task setup
            <br />
            Agent reports and results
          </p>
        </div>
      </aside>
      <div className="main-column">
        <header className="topbar">
          <a href="#/">Reporting Server Overview</a>
          <div className="connection-state">
            <span className={`live-dot ${hasRefreshError ? 'offline' : ''}`} aria-hidden="true" />
            <span>
              {hasRefreshError ? 'Refresh failed' : loading ? 'Connecting…' : 'Refreshes every 5s'}
            </span>
            <button className="text-button" onClick={() => setAccessOpen(true)}>
              API access{token ? ' · token set' : ''}
            </button>
          </div>
        </header>
        <main>
          {(listError || agentError) && (
            <div className="error-notice" role="alert">
              <p>{listError && `Task refresh: ${listError}`}</p>
              {agentError && agentError !== listError && <p>Executor refresh: {agentError}</p>}
              {lastRefresh && (
                <p>
                  Showing saved data from <DateLabel date={lastRefresh} />.
                </p>
              )}
              <div className="actions">
                <button className="text-button" onClick={() => setRefreshKey((key) => key + 1)}>
                  Retry refresh
                </button>
                <button className="text-button" onClick={() => setAccessOpen(true)}>
                  API access
                </button>
              </div>
            </div>
          )}
          {!loading && !agentError && !agents.length && (
            <section className="notice">
              <h2>No executors available</h2>
              <p>
                Wait for opencode discovery and server readiness, then refresh. A task needs an
                available executor.
              </p>
              <button className="secondary compact" onClick={() => setRefreshKey((key) => key + 1)}>
                Refresh executors
              </button>
            </section>
          )}
          {loading ? (
            <p className="muted" role="status">
              Loading reporting server…
            </p>
          ) : selectedId ? (
            <>
              {detailError && (
                <div className="error-notice" role="alert">
                  Task detail: {detailError}
                  {detail?.id === selectedId && <p>The last loaded task is shown below.</p>}
                  <button className="text-button" onClick={() => setRefreshKey((key) => key + 1)}>
                    Retry task refresh
                  </button>
                </div>
              )}
              {detail?.id === selectedId ? (
                <Workspace
                  key={selectedId}
                  task={detail}
                  agents={agents}
                  api={api}
                  onUpdate={update}
                />
              ) : !detailError ? (
                <p className="muted" role="status">
                  Loading task…
                </p>
              ) : (
                <a href="#/">Back to all tasks</a>
              )}
            </>
          ) : (
            <TaskList
              tasks={tasks}
              agents={agents}
              canCreate={agents.length > 0 && !agentError}
              onCreate={() => setCreating(true)}
            />
          )}
        </main>
      </div>
      {creating && (
        <CreateTask
          agents={agents}
          api={api}
          onClose={() => setCreating(false)}
          onAccepted={update}
          onCreated={created}
          onAccess={() => setAccessOpen(true)}
        />
      )}
      {accessOpen && (
        <ApiAccess
          currentToken={token}
          onClose={() => setAccessOpen(false)}
          onSave={(nextToken) => {
            setToken(nextToken);
            setAccessOpen(false);
            setRefreshKey((key) => key + 1);
          }}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
