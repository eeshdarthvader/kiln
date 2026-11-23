import type { StageRecord } from './types';
import { formatDuration } from './Insights';

/** Stages laid out against time: one bar per attempt, so slow stages and retries stand out. */
export function Timeline({ stages }: { stages: StageRecord[] }) {
  if (!stages.length) return null;
  const now = Date.now();
  const begin = Date.parse(stages[0]!.startedAt);
  const rows = stages.map((stage) => {
    const start = Date.parse(stage.startedAt);
    const end = stage.endedAt ? Date.parse(stage.endedAt) : now;
    return { stage, start, end, seconds: Math.max(0, (end - start) / 1000) };
  });
  const finish = Math.max(...rows.map((row) => row.end));
  const span = Math.max(1, finish - begin);
  return (
    <figure className="timeline">
      <figcaption className="muted small">
        {formatDuration((finish - begin) / 1000)} from first stage to{' '}
        {stages.at(-1)!.endedAt ? 'last' : 'now'}
      </figcaption>
      <ol>
        {rows.map(({ stage, start, end, seconds }, index) => (
          <li key={index} className={`timeline-row timeline-${stage.status}`}>
            <span className="timeline-name">
              {stage.name}
              {stage.attempt > 1 && <span className="label-badge">attempt {stage.attempt}</span>}
            </span>
            <span className="timeline-track" aria-hidden="true">
              <span
                className="timeline-bar"
                style={{
                  left: `${((start - begin) / span) * 100}%`,
                  width: `${Math.max(1.5, ((end - start) / span) * 100)}%`,
                }}
              />
            </span>
            <span className="timeline-time">
              {formatDuration(seconds)}
              <span className="sr-only">, {stage.status.replaceAll('_', ' ')}</span>
            </span>
          </li>
        ))}
      </ol>
    </figure>
  );
}
