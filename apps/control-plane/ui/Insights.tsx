import { useState } from 'react';
import type { RunSummary, StageName } from './types';

const order: StageName[] = [
  'classify',
  'plan',
  'plan-review',
  'implement',
  'review',
  'pr',
  'resolve',
];
const ranges = [
  { key: '7', label: 'Last 7 days', days: 7 },
  { key: '30', label: 'Last 30 days', days: 30 },
  { key: 'all', label: 'All time', days: Infinity },
];

const seconds = (from: string, to: string) =>
  Math.max(0, (Date.parse(to) - Date.parse(from)) / 1000);
export function formatDuration(total: number): string {
  if (!Number.isFinite(total)) return '–';
  const value = Math.round(total);
  if (value < 60) return `${value}s`;
  if (value < 3600) return `${Math.floor(value / 60)}m ${value % 60}s`;
  return `${Math.floor(value / 3600)}h ${Math.floor((value % 3600) / 60)}m`;
}
const median = (values: number[]) => {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

export interface Stats {
  total: number;
  finished: number;
  done: number;
  failed: number;
  cancelled: number;
  merged: number;
  successRate: number | null;
  medianRun: number;
  conflictRuns: number;
  resolveAttempts: number;
  retries: number;
  sentBack: number;
  stages: Array<{
    name: StageName;
    runs: number;
    average: number;
    median: number;
    retries: number;
  }>;
}

export function computeStats(runs: RunSummary[]): Stats {
  const done = runs.filter((run) => run.status === 'done');
  const failed = runs.filter((run) => run.status === 'failed').length;
  const cancelled = runs.filter((run) => run.status === 'cancelled').length;
  const finished = done.length + failed + cancelled;
  const stageRecords = runs.flatMap((run) => run.stages);
  const stages = order.flatMap((name) => {
    const records = stageRecords.filter((stage) => stage.name === name);
    const durations = records
      .filter((stage) => stage.endedAt)
      .map((stage) => seconds(stage.startedAt, stage.endedAt!));
    if (!records.length) return [];
    return [
      {
        name,
        runs: new Set(
          runs
            .filter((run) => run.stages.some((stage) => stage.name === name))
            .map((run) => run.id),
        ).size,
        average: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : NaN,
        median: median(durations),
        retries: records.filter((stage) => stage.attempt > 1).length,
      },
    ];
  });
  return {
    total: runs.length,
    finished,
    done: done.length,
    failed,
    cancelled,
    merged: runs.filter((run) => run.prState === 'merged').length,
    successRate: finished ? done.length / finished : null,
    medianRun: median(done.map((run) => seconds(run.createdAt, run.updatedAt))),
    conflictRuns: runs.filter((run) => run.stages.some((stage) => stage.name === 'resolve')).length,
    resolveAttempts: stageRecords.filter((stage) => stage.name === 'resolve').length,
    retries: stageRecords.filter((stage) => stage.attempt > 1).length,
    sentBack: stageRecords.filter((stage) => stage.status === 'changes_requested').length,
    stages,
  };
}

export function Insights({ runs }: { runs: RunSummary[] }) {
  const [range, setRange] = useState('30');
  const days = ranges.find((item) => item.key === range)!.days;
  const cutoff = Date.now() - days * 86_400_000;
  const inRange = runs.filter((run) => Date.parse(run.createdAt) >= cutoff);
  const stats = computeStats(inRange);
  const slowest = Math.max(
    1,
    ...stats.stages.map((stage) => (Number.isFinite(stage.average) ? stage.average : 0)),
  );
  const rate = stats.successRate === null ? '–' : `${Math.round(stats.successRate * 100)}%`;
  return (
    <>
      <header className="page-heading">
        <div>
          <p className="eyebrow">Kiln</p>
          <h1>Insights</h1>
          <p className="muted">
            How long each stage takes, how often runs succeed and how often parallel runs collide.
          </p>
        </div>
        <label className="range-select">
          Period
          <select value={range} onChange={(event) => setRange(event.target.value)}>
            {ranges.map((item) => (
              <option key={item.key} value={item.key}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
      </header>
      {stats.total === 0 ? (
        <section className="panel">
          <div className="empty-state">
            <h3>No runs in this period</h3>
            <p className="muted">Pick a longer period, or label an issue to start a run.</p>
          </div>
        </section>
      ) : (
        <>
          <ul className="overview-stats insight-stats" aria-label="Summary">
            <li>
              <strong>{rate}</strong> success rate
              <span className="insight-sub">
                {stats.done} done · {stats.failed} failed · {stats.cancelled} cancelled
              </span>
            </li>
            <li>
              <strong>{formatDuration(stats.medianRun)}</strong> median time to done
              <span className="insight-sub">{stats.merged} pull requests merged</span>
            </li>
            <li>
              <strong>{stats.conflictRuns}</strong> runs hit a conflict
              <span className="insight-sub">
                {stats.resolveAttempts} resolve attempt{stats.resolveAttempts === 1 ? '' : 's'}
              </span>
            </li>
            <li>
              <strong>{stats.retries}</strong> stage retries
              <span className="insight-sub">{stats.sentBack} sent back by review</span>
            </li>
          </ul>
          <section className="panel" aria-labelledby="stage-time-heading">
            <div className="section-heading">
              <h2 id="stage-time-heading">Time per stage</h2>
            </div>
            <table className="insight-table">
              <caption className="sr-only">Average and median time per stage, with retries</caption>
              <thead>
                <tr>
                  <th scope="col">Stage</th>
                  <th scope="col">Average</th>
                  <th scope="col" className="hide-small">
                    Median
                  </th>
                  <th scope="col" className="hide-small">
                    Runs
                  </th>
                  <th scope="col">Retries</th>
                  <th scope="col" aria-hidden="true" />
                </tr>
              </thead>
              <tbody>
                {stats.stages.map((stage) => (
                  <tr key={stage.name}>
                    <th scope="row">{stage.name}</th>
                    <td>{formatDuration(stage.average)}</td>
                    <td className="hide-small">{formatDuration(stage.median)}</td>
                    <td className="hide-small">{stage.runs}</td>
                    <td>{stage.retries}</td>
                    <td aria-hidden="true" className="insight-bar-cell">
                      <span
                        className="insight-bar"
                        style={{
                          width: `${Math.round(((Number.isFinite(stage.average) ? stage.average : 0) / slowest) * 100)}%`,
                        }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </>
  );
}
