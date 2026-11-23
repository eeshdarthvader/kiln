import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AddIssue } from './AddIssue';
import { createApi, errorText, runPath, subscribe } from './api';
import { Modal, ToastProvider } from './components';
import { Insights } from './Insights';
import { Logo } from './Logo';
import { RunDetail } from './RunDetail';
import { RunList, issueRef } from './RunList';
import type { FactoryInfo, Run, RunSummary } from './types';
import './styles.css';
import './shell.css';

function selectedFromHash(): string | null {
  try {
    return window.location.hash.startsWith('#/runs/')
      ? decodeURIComponent(window.location.hash.slice(7)) || null
      : null;
  } catch {
    return null;
  }
}

const insightsFromHash = () => window.location.hash === '#/insights';

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
  const [insights, setInsights] = useState(insightsFromHash);
  const [detail, setDetail] = useState<Run | null>(null);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [detailError, setDetailError] = useState('');
  const [live, setLive] = useState(false);
  const [adding, setAdding] = useState(false);
  const [accessOpen, setAccessOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const statuses = useRef(new Map<string, string>());
  const mainRef = useRef<HTMLElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const firstRoute = useRef(true);
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;

  useEffect(() => {
    const change = () => {
      setInsights(insightsFromHash());
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
        for (const run of list.runs) statuses.current.set(run.id, run.status);
        setListError('');
      })
      .catch((reason: unknown) => !cancelled && setListError(errorText(reason)))
      .finally(() => !cancelled && setLoading(false));
    const stop = subscribe(
      token,
      (value) => {
        const run = value as RunSummary;
        const before = statuses.current.get(run.id);
        statuses.current.set(run.id, run.status);
        if (before && before !== run.status)
          setAnnouncement(`${run.title} is now ${run.status.replaceAll('_', ' ')}.`);
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

  const attention = runs.filter((run) => run.status === 'needs_input').length;
  useEffect(() => {
    const name =
      selectedId && detail?.id === selectedId
        ? `${detail.title} · Kiln`
        : insights && !selectedId
          ? 'Insights · Kiln'
          : 'Kiln';
    document.title = attention ? `(${attention}) ${name}` : name;
  }, [selectedId, detail, attention, insights]);

  // After navigating, move focus to the new page so keyboard and screen-reader users start there.
  useEffect(() => {
    setMenuOpen(false);
    if (firstRoute.current) {
      firstRoute.current = false;
      return;
    }
    mainRef.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }, [selectedId, insights]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
      const target = event.target as HTMLElement | null;
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        target?.closest('input, textarea, select, [contenteditable], .xterm, dialog')
      )
        return;
      if (event.key === '/') {
        event.preventDefault();
        setMenuOpen(true);
        setTimeout(() => filterRef.current?.focus(), 0);
      } else if (event.key === 'n') {
        event.preventDefault();
        setAdding(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function update(run: Run) {
    if (selectedRef.current === run.id) setDetail(run);
    setRuns((previous) =>
      previous.some((item) => item.id === run.id)
        ? previous.map((item) => (item.id === run.id ? run : item))
        : [run, ...previous],
    );
  }
  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? runs.filter((run) =>
        `${run.title} #${run.issueNumber} ${run.repo} ${run.status.replaceAll('_', ' ')}`
          .toLowerCase()
          .includes(needle),
      )
    : runs;
  const active = runs.filter((run) => run.status === 'running' || run.status === 'queued').length;
  return (
    <ToastProvider>
      <div className="app-shell">
        <a
          className="skip-link"
          href="#content"
          onClick={(event) => {
            event.preventDefault();
            mainRef.current?.focus();
          }}
        >
          Skip to content
        </a>
        <p className="sr-only" role="status" aria-live="polite">
          {announcement}
        </p>
        {menuOpen && (
          <div className="scrim" aria-hidden="true" onClick={() => setMenuOpen(false)} />
        )}
        <aside className={`sidebar ${menuOpen ? 'sidebar-open' : ''}`} id="sidebar">
          <a className="brand" href="#/">
            <Logo size={40} />
            <span>
              Kiln
              <small>Issue → PR</small>
            </span>
          </a>
          <nav className="side-nav" aria-label="Runs">
            <a className="nav-item" href="#/" aria-current={!selectedId ? 'page' : undefined}>
              All runs <span>{runs.length}</span>
            </a>
            <a
              className="nav-item"
              href="#/insights"
              aria-current={insights && !selectedId ? 'page' : undefined}
            >
              Insights
            </a>
            {runs.length > 5 && (
              <div className="run-filter">
                <label className="sr-only" htmlFor="run-filter">
                  Filter runs
                </label>
                <input
                  id="run-filter"
                  ref={filterRef}
                  type="search"
                  placeholder="Filter runs  ( / )"
                  autoComplete="off"
                  spellCheck={false}
                  aria-keyshortcuts="/"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape' && filter) {
                      event.stopPropagation();
                      setFilter('');
                    }
                  }}
                />
              </div>
            )}
            <div className="run-nav">
              <ol>
                {shown.map((run) => (
                  <li key={run.id}>
                    <a
                      href={`#/runs/${encodeURIComponent(run.id)}`}
                      aria-current={run.id === selectedId ? 'page' : undefined}
                      title={`${run.ticket?.key ?? `${run.repo}#${run.issueNumber}`}: ${run.title} (${run.status.replaceAll('_', ' ')})`}
                    >
                      <span className={`run-dot run-dot-${run.status}`} aria-hidden="true" />
                      <span className="run-nav-text">
                        <span className="run-nav-title">{run.title}</span>
                        <span className="run-nav-meta">
                          {issueRef(run)} · {run.status.replaceAll('_', ' ')}
                        </span>
                      </span>
                    </a>
                  </li>
                ))}
              </ol>
              {needle && !shown.length && (
                <p className="muted small run-empty">No runs match “{filter}”.</p>
              )}
            </div>
          </nav>
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
            <button
              type="button"
              className="menu-button secondary compact"
              aria-expanded={menuOpen}
              aria-controls="sidebar"
              onClick={() => setMenuOpen((open) => !open)}
            >
              Runs
            </button>
            <a href="#/">Kiln</a>
            <div className="connection-state" role="status">
              <span className={`live-dot ${live ? '' : 'offline'}`} aria-hidden="true" />
              <span>{live ? 'Live' : loading ? 'Connecting…' : 'Reconnecting…'}</span>
              <button className="text-button" onClick={() => setAccessOpen(true)}>
                API access{token ? ' · token set' : ''}
              </button>
            </div>
          </header>
          <main
            id="content"
            ref={mainRef}
            tabIndex={-1}
            key={selectedId ?? (insights ? 'insights' : 'runs')}
          >
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
                    terminal={factory?.terminal ?? false}
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
            ) : insights ? (
              <Insights runs={runs} />
            ) : (
              <RunList
                api={api}
                onUpdate={update}
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
    </ToastProvider>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
