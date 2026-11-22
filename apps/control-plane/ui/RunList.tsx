import { useState } from 'react';
import { DateLabel, Status } from './components';
import type { FactoryInfo, RunStatus, RunSummary } from './types';

const isMerged = (run: RunSummary) => run.status === 'done' && run.prState === 'merged';
const groups: Array<{ key: string; title: string; match: (run: RunSummary) => boolean }> = [
  { key: 'needs_input', title: 'Needs input', match: (run) => run.status === 'needs_input' },
  { key: 'running', title: 'Running', match: (run) => run.status === 'running' },
  { key: 'queued', title: 'Queued', match: (run) => run.status === 'queued' },
  { key: 'failed', title: 'Failed', match: (run) => run.status === 'failed' },
  {
    key: 'open',
    title: 'Pull request open',
    match: (run) => run.status === 'done' && run.prState !== 'merged' && run.prState !== 'closed',
  },
  { key: 'merged', title: 'Merged', match: isMerged },
  {
    key: 'closed',
    title: 'Pull request closed',
    match: (run) => run.status === 'done' && run.prState === 'closed',
  },
  { key: 'cancelled', title: 'Cancelled', match: (run) => run.status === 'cancelled' },
];

/** A short label for where the run's pull request stands, shown next to the run. */
export const prLabel = (run: Pick<RunSummary, 'prUrl' | 'prState'>) =>
  run.prUrl ? `PR ${run.prState ?? 'open'}` : null;

export const issueLabel = (run: Pick<RunSummary, 'repo' | 'issueNumber'>) =>
  `${run.repo}#${run.issueNumber}`;

function RunRow({ run }: { run: RunSummary }) {
  const stage = run.stages.at(-1);
  return (
    <li>
      <a
        className={`task-row ${run.status === 'needs_input' ? 'task-attention' : ''}`}
        href={`#/runs/${encodeURIComponent(run.id)}`}
      >
        <span className="queue-number">#{run.issueNumber}</span>
        <div className="task-summary">
          <div className="task-title">
            <h3>{run.title}</h3>
            <span aria-hidden="true">↗</span>
          </div>
          <p className="muted">{run.repo}</p>
          <p className="task-note">
            {run.statusReason ?? stage?.summary ?? 'Waiting for a free slot.'}
          </p>
          <div className="status-row">
            <Status value={run.status} />
            {stage && run.status === 'running' && (
              <span className="label-badge">
                {stage.name}
                {stage.attempt > 1 ? ` · attempt ${stage.attempt}` : ''}
              </span>
            )}
            {prLabel(run) && (
              <span className={`label-badge pr-${run.prState ?? 'open'}`}>{prLabel(run)}</span>
            )}
            <span className="muted small">
              Updated <DateLabel date={run.updatedAt} />
            </span>
          </div>
        </div>
      </a>
    </li>
  );
}

export function RunList({
  runs,
  factory,
  onAdd,
  onPoll,
}: {
  runs: RunSummary[];
  factory: FactoryInfo | null;
  onAdd: () => void;
  onPoll: () => Promise<void>;
}) {
  const [polling, setPolling] = useState(false);
  const count = (status: RunStatus) => runs.filter((run) => run.status === status).length;
  return (
    <>
      <header className="page-heading">
        <div>
          <p className="eyebrow">Software Factory</p>
          <h1>Runs</h1>
          <p className="muted">
            Each run takes one GitHub issue through classify, plan, review, implement, review and a
            draft pull request.
          </p>
        </div>
        <button type="button" onClick={onAdd}>
          + Add issue
        </button>
      </header>
      <div className="overview-stats">
        <span>
          <strong>{count('running')}</strong> running
        </span>
        <span>
          <strong>{count('queued')}</strong> queued
        </span>
        <span>
          <strong>{count('needs_input')}</strong> need input
        </span>
        <span>
          <strong>
            {runs.filter((run) => run.status === 'done' && run.prState !== 'merged').length}
          </strong>{' '}
          open PRs
        </span>
        <span>
          <strong>{runs.filter(isMerged).length}</strong> merged
        </span>
        <span>
          <strong>{count('failed')}</strong> failed
        </span>
      </div>
      {factory && (
        <section className="panel">
          <div className="section-heading">
            <h2>Issue intake</h2>
            <button
              type="button"
              className="secondary compact"
              disabled={polling || !factory.repos.length}
              onClick={() => {
                setPolling(true);
                void onPoll().finally(() => setPolling(false));
              }}
            >
              {polling ? 'Checking…' : 'Check now'}
            </button>
          </div>
          {factory.repos.length ? (
            <p className="muted">
              Watching{' '}
              {factory.repos.map((repo) => (
                <span className="label-badge" key={repo}>
                  {repo}
                </span>
              ))}{' '}
              for open issues labelled <span className="label-badge">{factory.label}</span>
              {factory.pollSeconds
                ? ` every ${factory.pollSeconds}s`
                : ' (automatic checks are off)'}
              . Up to {factory.maxRuns} runs at once.
              {factory.lastPollAt && (
                <>
                  {' '}
                  Last checked <DateLabel date={factory.lastPollAt} />.
                </>
              )}
            </p>
          ) : (
            <p className="muted">
              No repositories are watched. Set <span className="path">FACTORY_REPOS</span> to pick
              up labelled issues automatically, or add an issue by URL.
            </p>
          )}
          {factory.lastError && (
            <p className="error" role="alert">
              Last check failed: {factory.lastError}
            </p>
          )}
        </section>
      )}
      {runs.length ? (
        groups
          .filter((group) => runs.some(group.match))
          .map((group) => (
            <section className="panel tasks-panel" key={group.key}>
              <div className="section-heading">
                <h2>
                  {group.title} <span className="count">{runs.filter(group.match).length}</span>
                </h2>
              </div>
              <ol className="task-list">
                {runs.filter(group.match).map((run) => (
                  <RunRow key={run.id} run={run} />
                ))}
              </ol>
            </section>
          ))
      ) : (
        <section className="panel tasks-panel">
          <div className="empty-state">
            <h3>No runs yet</h3>
            <p className="muted">
              Label an issue <span className="label-badge">{factory?.label ?? 'factory'}</span> in a
              watched repository, or add one by URL.
            </p>
            <button className="secondary" onClick={onAdd}>
              Add an issue
            </button>
          </div>
        </section>
      )}
    </>
  );
}
