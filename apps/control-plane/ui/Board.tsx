import { DateLabel } from './components';
import { issueLabel } from './RunList';
import type { RunSummary, StageName } from './types';

const stageColumns: Array<{ key: StageName; title: string }> = [
  { key: 'classify', title: 'Classify' },
  { key: 'plan', title: 'Plan' },
  { key: 'plan-review', title: 'Plan review' },
  { key: 'implement', title: 'Implement' },
  { key: 'review', title: 'Review' },
  { key: 'pr', title: 'Pull request' },
  { key: 'resolve', title: 'Resolving conflicts' },
];

interface Column {
  key: string;
  title: string;
  keepEmpty: boolean;
  match: (run: RunSummary) => boolean;
}

const columns: Column[] = [
  { key: 'queued', title: 'Queued', keepEmpty: true, match: (run) => run.status === 'queued' },
  ...stageColumns.map(({ key, title }): Column => ({
    key,
    title,
    keepEmpty: key !== 'resolve',
    match: (run) => run.status === 'running' && run.stages.at(-1)?.name === key,
  })),
  {
    key: 'needs_input',
    title: 'Needs you',
    keepEmpty: true,
    match: (run) => run.status === 'needs_input',
  },
  {
    key: 'open',
    title: 'PR open',
    keepEmpty: true,
    match: (run) => run.status === 'done' && run.prState !== 'merged' && run.prState !== 'closed',
  },
  {
    key: 'merged',
    title: 'Merged',
    keepEmpty: true,
    match: (run) => run.status === 'done' && run.prState === 'merged',
  },
  {
    key: 'failed',
    title: 'Failed or stopped',
    keepEmpty: false,
    match: (run) =>
      run.status === 'failed' ||
      run.status === 'cancelled' ||
      (run.status === 'done' && run.prState === 'closed'),
  },
];

/** Runs as columns, one per pipeline stage, so you can see where work is piling up. */
export function Board({ runs, overlapping }: { runs: RunSummary[]; overlapping: Set<string> }) {
  return (
    <div className="board" role="group" aria-label="Runs by stage" tabIndex={0}>
      {columns
        .map((column) => ({ column, items: runs.filter(column.match) }))
        .filter(({ column, items }) => column.keepEmpty || items.length)
        .map(({ column, items }) => (
          <section className="board-column" key={column.key} aria-labelledby={`col-${column.key}`}>
            <h3 id={`col-${column.key}`}>
              {column.title} <span className="count">{items.length}</span>
            </h3>
            {items.length ? (
              <ul>
                {items.map((run) => (
                  <li key={run.id} className={`board-card board-${run.status}`}>
                    <a href={`#/runs/${encodeURIComponent(run.id)}`}>{run.title}</a>
                    <p className="muted small">
                      {issueLabel(run)} · <DateLabel date={run.updatedAt} />
                    </p>
                    {overlapping.has(run.id) && (
                      <span className="label-badge overlap-badge">
                        Shares files with another run
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small board-empty">Empty</p>
            )}
          </section>
        ))}
    </div>
  );
}
