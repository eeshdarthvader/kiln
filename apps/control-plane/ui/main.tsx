import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AddIssue } from './AddIssue';
import { createApi, errorText, runPath, subscribe } from './api';
import { Modal, ToastProvider } from './components';
import { Insights } from './Insights';
import { Logo } from './Logo';
import { RunDetail } from './RunDetail';
import { RunList, issueRef } from './RunList';
import type { FactoryInfo, Overlap, Run, RunSummary } from './types';
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

function initialNotify(): 'on' | 'off' | 'blocked' | 'unsupported' {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  try {
    return Notification.permission === 'granted' && localStorage.getItem('kiln-notify') === 'on'
      ? 'on'
      : 'off';
  } catch {
    return 'off';
  }
}

const notifyReasons: Record<string, string> = {
  needs_input: 'needs your input',
  failed: 'failed',
  done: 'finished',
};

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
  const [overlaps, setOverlaps] = useState<Overlap[]>([]);
  const [notify, setNotify] = useState<'on' | 'off' | 'blocked' | 'unsupported'>(initialNotify);
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
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
        if (before && before !== run.status) {
          setAnnouncement(`${run.title} is now ${run.status.replaceAll('_', ' ')}.`);
          const reason = notifyReasons[run.status];
          if (reason && notifyRef.current === 'on' && !document.hasFocus()) {
            const popup = new Notification(`${run.title} ${reason}`, {
              body: `${run.repo}#${run.issueNumber}`,
              tag: run.id,
            });
            popup.onclick = () => {
              window.focus();
              window.location.hash = `/runs/${encodeURIComponent(run.id)}`;
              popup.close();
            };
          }
        }
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

  const activeCount = runs.filter((run) =>
    ['queued', 'running', 'needs_input'].includes(run.status),
  ).length;
  const activeKey = runs
    .filter((run) => ['queued', 'running', 'needs_input'].includes(run.status))
    .map((run) => `${run.id}:${run.status}`)
    .join(',');
  useEffect(() => {
    if (activeCount < 2) {
      setOverlaps([]);
      return;
    }
    let cancelled = false;
    const load = () =>
      api<{ overlaps: Overlap[] }>('/overlaps')
        .then((value) => !cancelled && setOverlaps(value.overlaps))
        .catch(() => {});
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [api, activeCount, activeKey]);
  const overlapping = useMemo(() => new Set(overlaps.flatMap((item) => item.runIds)), [overlaps]);
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
  // Group by repository, in the order each repository first appears (runs are newest first).
  const groups = [
    ...shown
      .reduce(
        (map, run) => map.set(run.repo, [...(map.get(run.repo) ?? []), run]),
        new Map<string, RunSummary[]>(),
      )
      .entries(),
  ];
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
            <a
              className="nav-item"
              href="#/"
              aria-current={!selectedId && !insights ? 'page' : undefined}
            >
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
              {groups.map(([repo, items]) => (
                <details key={repo} className="run-group" open>
                  <summary title={repo}>
                    <span className="run-group-name">{repo.split('/').at(-1)}</span>
                    <span className="run-group-count">{items.length}</span>
                  </summary>
                  <ol>
                    {items.map((run) => (
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
                </details>
              ))}
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
              {notify !== 'unsupported' && (
                <button
                  type="button"
                  className="text-button"
                  aria-pressed={notify === 'on'}
                  disabled={notify === 'blocked'}
                  title={
                    notify === 'blocked'
                      ? 'Notifications are blocked in your browser settings.'
                      : 'Get a desktop notification when a run needs you, fails or finishes while this tab is in the background.'
                  }
                  onClick={() => {
                    const remember = (value: string) => {
                      try {
                        localStorage.setItem('kiln-notify', value);
                      } catch {
                        // The choice just is not remembered.
                      }
                    };
                    if (notify === 'on') {
                      setNotify('off');
                      remember('off');
                      return;
                    }
                    void Notification.requestPermission().then((permission) => {
                      setNotify(
                        permission === 'granted'
                          ? 'on'
                          : permission === 'denied'
                            ? 'blocked'
                            : 'off',
                      );
                      if (permission === 'granted') remember('on');
                    });
                  }}
                >
                  {notify === 'blocked' ? 'Notifications blocked' : `Notifications ${notify}`}
                </button>
              )}
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
                    overlaps={overlaps.filter((item) => item.runIds.includes(selectedId))}
                    runs={runs}
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
                overlapping={overlapping}
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
