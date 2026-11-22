import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AddIssue } from './AddIssue';
import { createApi, errorText, runPath, subscribe } from './api';
import { Modal } from './components';
import { RunDetail } from './RunDetail';
import { RunList } from './RunList';
import type { FactoryInfo, Run, RunSummary } from './types';
import './styles.css';

function selectedFromHash(): string | null {
  try {
    return window.location.hash.startsWith('#/runs/')
      ? decodeURIComponent(window.location.hash.slice(7)) || null
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
        If this server requires FACTORY_API_TOKEN, enter it here. The token stays in memory for this
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
  const [factory, setFactory] = useState<FactoryInfo | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selectedId, setSelectedId] = useState(selectedFromHash);
  const [detail, setDetail] = useState<Run | null>(null);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [detailError, setDetailError] = useState('');
  const [live, setLive] = useState(false);
  const [adding, setAdding] = useState(false);
  const [accessOpen, setAccessOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
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

  // The list loads once, then the event stream keeps it current.
  useEffect(() => {
    let cancelled = false;
    Promise.all([api<FactoryInfo>('/factory'), api<{ runs: RunSummary[] }>('/runs')])
      .then(([info, list]) => {
        if (cancelled) return;
        setFactory(info);
        setRuns(list.runs);
        setListError('');
      })
      .catch((reason: unknown) => !cancelled && setListError(errorText(reason)))
      .finally(() => !cancelled && setLoading(false));
    const stop = subscribe(
      token,
      (value) => {
        const run = value as RunSummary;
        setRuns((previous) =>
          previous.some((item) => item.id === run.id)
            ? previous.map((item) => (item.id === run.id ? run : item))
            : [run, ...previous],
        );
        // Events carry summaries; reload the open run for its plan and attachments.
        if (run.id === selectedRef.current) setRefreshKey((key) => key + 1);
      },
      setLive,
    );
    return () => {
      cancelled = true;
      stop();
    };
  }, [api, token]);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    api<Run>(runPath(selectedId))
      .then((run) => {
        if (cancelled) return;
        setDetail(run);
        setDetailError('');
      })
      .catch((reason: unknown) => !cancelled && setDetailError(errorText(reason)));
    return () => void (cancelled = true);
  }, [api, selectedId, refreshKey]);

  function update(run: Run) {
    if (selectedRef.current === run.id) setDetail(run);
    setRuns((previous) =>
      previous.some((item) => item.id === run.id)
        ? previous.map((item) => (item.id === run.id ? run : item))
        : [run, ...previous],
    );
  }
  const active = runs.filter((run) => run.status === 'running' || run.status === 'queued').length;
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
        <p className="eyebrow nav-label">Factory</p>
        <a className="nav-item" href="#/" aria-current={!selectedId ? 'page' : undefined}>
          Runs <span>{runs.length}</span>
        </a>
        <div className="sidebar-bottom">
          <span className="poc-badge">Herdr · {factory?.herdrSession ?? '…'}</span>
          <p>
            {active} active
            <br />
            GitHub issue → draft PR
          </p>
        </div>
      </aside>
      <div className="main-column">
        <header className="topbar">
          <a href="#/">Software Factory</a>
          <div className="connection-state">
            <span className={`live-dot ${live ? '' : 'offline'}`} aria-hidden="true" />
            <span>{live ? 'Live' : loading ? 'Connecting…' : 'Reconnecting…'}</span>
            <button className="text-button" onClick={() => setAccessOpen(true)}>
              API access{token ? ' · token set' : ''}
            </button>
          </div>
        </header>
        <main>
          {listError && (
            <div className="error-notice" role="alert">
              <p>Could not load runs: {listError}</p>
              <div className="actions">
                <button className="text-button" onClick={() => setAccessOpen(true)}>
                  API access
                </button>
              </div>
            </div>
          )}
          {loading ? (
            <p className="muted" role="status">
              Loading the factory…
            </p>
          ) : selectedId ? (
            <>
              {detailError && (
                <div className="error-notice" role="alert">
                  Run detail: {detailError}
                  <button className="text-button" onClick={() => setRefreshKey((key) => key + 1)}>
                    Retry
                  </button>
                </div>
              )}
              {detail?.id === selectedId ? (
                <RunDetail
                  key={selectedId}
                  run={detail}
                  api={api}
                  herdrSession={factory?.herdrSession ?? 'factory'}
                  onUpdate={update}
                />
              ) : !detailError ? (
                <p className="muted" role="status">
                  Loading run…
                </p>
              ) : (
                <a href="#/">Back to all runs</a>
              )}
            </>
          ) : (
            <RunList
              runs={runs}
              factory={factory}
              onAdd={() => setAdding(true)}
              onPoll={async () => {
                await api('/poll', 'POST').catch((reason: unknown) =>
                  setListError(errorText(reason)),
                );
                await api<FactoryInfo>('/factory')
                  .then(setFactory)
                  .catch(() => {});
              }}
            />
          )}
        </main>
      </div>
      {adding && (
        <AddIssue
          api={api}
          onClose={() => setAdding(false)}
          onCreated={(run) => {
            update(run);
            setAdding(false);
            window.location.hash = `/runs/${encodeURIComponent(run.id)}`;
          }}
        />
      )}
      {accessOpen && (
        <ApiAccess
          currentToken={token}
          onClose={() => setAccessOpen(false)}
          onSave={(nextToken) => {
            setToken(nextToken);
            setAccessOpen(false);
          }}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
