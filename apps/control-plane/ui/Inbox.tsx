import { useState } from 'react';
import { errorText, runPath, type Api } from './api';
import { DateLabel, safeUrl, useToast } from './components';
import { issueLabel } from './RunList';
import type { Run, RunSummary } from './types';

interface Item {
  run: RunSummary;
  rank: number;
  kind: string;
  detail: string;
  action?: { label: string; path: 'approve' | 'retry' };
}

/** Everything waiting on a person, most blocking first. */
export function attention(runs: RunSummary[]): Item[] {
  const items: Item[] = [];
  for (const run of runs) {
    if (run.approval)
      items.push({
        run,
        rank: 0,
        kind: `Approval needed after ${run.approval.after}`,
        detail: run.approval.reasons.join(' · '),
        action: { label: 'Approve', path: 'approve' },
      });
    else if (run.status === 'needs_input')
      items.push({
        run,
        rank: 1,
        kind: 'The agent asked a question',
        detail: run.statusReason ?? 'Answer on the issue, then run it again.',
      });
    else if (run.status === 'failed')
      items.push({
        run,
        rank: 2,
        kind: 'The run failed',
        detail: run.statusReason ?? 'No reason was recorded.',
        action: { label: 'Run again', path: 'retry' },
      });
    else if (
      run.status === 'done' &&
      run.prUrl &&
      (run.prState === 'open' || run.prState === 'draft') &&
      run.merge !== 'requested'
    )
      items.push({
        run,
        rank: 3,
        kind: run.merge === 'failed' ? 'Merge failed' : 'Pull request ready for review',
        detail:
          run.merge === 'held'
            ? 'Held for a human by the autonomy policy.'
            : run.merge === 'failed'
              ? 'Auto-merge did not go through. Merge it by hand.'
              : 'Review the changes and merge it.',
      });
  }
  return items.sort(
    (a, b) => a.rank - b.rank || Date.parse(b.run.updatedAt) - Date.parse(a.run.updatedAt),
  );
}

export function Inbox({
  runs,
  api,
  onUpdate,
}: {
  runs: RunSummary[];
  api: Api;
  onUpdate: (run: Run) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();
  const items = attention(runs);
  return (
    <section className="panel inbox" aria-labelledby="inbox-heading">
      <div className="section-heading">
        <h2 id="inbox-heading">
          Needs you <span className="count">{items.length}</span>
        </h2>
      </div>
      {items.length === 0 ? (
        <p className="muted empty-copy">
          Nothing is waiting on you. Runs that need a decision show up here.
        </p>
      ) : (
        <ul className="inbox-list">
          {items.map(({ run, kind, detail, action }) => {
            const prUrl = run.prUrl ? safeUrl(run.prUrl) : undefined;
            return (
              <li
                key={`${run.id}-${kind}`}
                className={`inbox-item inbox-${action?.path ?? 'look'}`}
              >
                <div className="inbox-text">
                  <p className="inbox-kind">{kind}</p>
                  <a className="inbox-title" href={`#/runs/${encodeURIComponent(run.id)}`}>
                    {run.title}
                    <span className="sr-only"> ({issueLabel(run)})</span>
                  </a>
                  <p className="muted small">
                    {issueLabel(run)} · <DateLabel date={run.updatedAt} />
                  </p>
                  <p className="task-note">{detail}</p>
                </div>
                <div className="inbox-actions">
                  {action && (
                    <button
                      type="button"
                      className={action.path === 'approve' ? '' : 'secondary'}
                      disabled={busy === run.id}
                      onClick={() => {
                        setBusy(run.id);
                        api<Run>(`${runPath(run.id)}/${action.path}`, 'POST')
                          .then((updated) => {
                            onUpdate(updated);
                            toast(
                              action.path === 'approve'
                                ? 'Approved. The run continues.'
                                : 'Run restarted.',
                            );
                          })
                          .catch((reason: unknown) => toast(errorText(reason), 'error'))
                          .finally(() => setBusy(null));
                      }}
                    >
                      {action.label}
                      <span className="sr-only"> {run.title}</span>
                    </button>
                  )}
                  {prUrl && (
                    <a
                      className="button-link"
                      href={`${prUrl}/files`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open pull request
                      <span className="sr-only"> for {run.title}</span>
                    </a>
                  )}
                  <a className="button-link" href={`#/runs/${encodeURIComponent(run.id)}`}>
                    {run.approval ? 'Review or send back' : 'Open run'}
                    <span className="sr-only"> {run.title}</span>
                  </a>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
