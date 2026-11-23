import { useEffect, useState } from 'react';
import { errorText, runPath, type Api } from './api';
import { Changes } from './Changes';
import { AttachmentPreview } from './AttachmentPreview';
import { Attachments } from './Attachments';
import {
  ConfirmDialog,
  CopyButton,
  DateLabel,
  Markdown,
  PlanProgress,
  Status,
  safeUrl,
  useToast,
} from './components';
import { issueLabel, prLabel } from './RunList';
import { WebTerminal } from './WebTerminal';
import type { Run, StageRecord } from './types';

function duration(stage: StageRecord): string {
  const seconds = Math.max(
    0,
    Math.round(
      (Date.parse(stage.endedAt ?? new Date().toISOString()) - Date.parse(stage.startedAt)) / 1000,
    ),
  );
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Recent terminal output of the stage's Herdr pane, refreshed while the run is active. */
function Terminal({ run, api }: { run: Run; api: Api }) {
  const [tail, setTail] = useState<{ stage: string | null; text: string } | null>(null);
  const active = run.status === 'running';
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api<{ stage: string | null; text: string }>(`${runPath(run.id)}/tail`)
        .then((value) => !cancelled && setTail(value))
        .catch(() => {});
    void load();
    if (!active) return () => void (cancelled = true);
    const timer = setInterval(() => void load(), 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [api, run.id, active, run.stages.length]);
  return (
    <section className="panel">
      <div className="section-heading">
        <h2>Agent terminal{tail?.stage ? ` · ${tail.stage}` : ''}</h2>
        <span className="muted small">{active ? 'Refreshes every 3s' : 'Not running'}</span>
      </div>
      {tail?.text.trim() ? (
        <pre className="terminal" tabIndex={0} aria-label="Recent agent terminal output">
          {tail.text.trimEnd()}
        </pre>
      ) : (
        <p className="muted empty-copy">
          {active ? 'No output yet.' : 'The pane was closed when the stage ended.'}
        </p>
      )}
    </section>
  );
}

export function RunDetail({
  run,
  api,
  herdrSession,
  terminal,
  onUpdate,
}: {
  run: Run;
  api: Api;
  herdrSession: string;
  terminal: boolean;
  onUpdate: (run: Run) => void;
}) {
  // Older finished runs were stored with every step still pending; a done run did them all.
  const finishedPlan =
    run.status === 'done'
      ? {
          ...run.plan,
          steps: run.plan.steps.map((step) => ({ ...step, status: 'completed' as const })),
        }
      : run.plan;
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const toast = useToast();
  const [attachmentId, setAttachmentId] = useState<string | null>(null);
  const act = (action: 'retry' | 'cancel') => {
    setBusy(true);
    setError('');
    api<Run>(`${runPath(run.id)}/${action}`, 'POST')
      .then((updated) => {
        onUpdate(updated);
        toast(action === 'retry' ? 'Run restarted.' : 'Run cancelled.');
      })
      .catch((reason: unknown) => setError(errorText(reason)))
      .finally(() => setBusy(false));
  };
  const [feedback, setFeedback] = useState('');
  const decide = (action: 'approve' | 'reject') => {
    setBusy(true);
    setError('');
    api<Run>(`${runPath(run.id)}/${action}`, 'POST', action === 'reject' ? { feedback } : undefined)
      .then((updated) => {
        setFeedback('');
        onUpdate(updated);
        toast(
          action === 'approve' ? 'Approved. The run continues.' : 'Sent back with your feedback.',
        );
      })
      .catch((reason: unknown) => setError(errorText(reason)))
      .finally(() => setBusy(false));
  };
  const canRetry = ['failed', 'needs_input', 'cancelled'].includes(run.status);
  const canCancel = ['queued', 'running', 'needs_input'].includes(run.status);
  const issueUrl = safeUrl(run.issueUrl);
  const prUrl = run.prUrl ? safeUrl(run.prUrl) : undefined;
  return (
    <>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <a href="#/">Runs</a> / {issueLabel(run)}
      </nav>
      <header className="workspace-heading">
        <div>
          <p className="eyebrow">{issueLabel(run)}</p>
          <h1>{run.title}</h1>
          <div className="status-row">
            <Status value={run.status} />
            {issueUrl && (
              <a href={issueUrl} target="_blank" rel="noreferrer">
                Issue ↗
              </a>
            )}
            {prUrl && (
              <a href={prUrl} target="_blank" rel="noreferrer">
                Pull request ↗
              </a>
            )}
            {prLabel(run) && (
              <Status value={run.prState === 'merged' ? 'done' : 'queued'} label={prLabel(run)!} />
            )}
            <span className="muted">
              Updated <DateLabel date={run.updatedAt} />
            </span>
          </div>
        </div>
        <div className="actions">
          {canRetry && (
            <button type="button" disabled={busy} onClick={() => act('retry')}>
              Run again
            </button>
          )}
          {canCancel && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => setConfirmCancel(true)}
            >
              Cancel run
            </button>
          )}
        </div>
      </header>
      {confirmCancel && (
        <ConfirmDialog
          title="Cancel this run?"
          confirm="Cancel run"
          onClose={() => setConfirmCancel(false)}
          onConfirm={() => act('cancel')}
        >
          <p className="muted">
            The running agent stops and its workspace is closed. Work already pushed stays on the
            branch, and you can start the run again later.
          </p>
        </ConfirmDialog>
      )}
      {error && (
        <p className="error-notice" role="alert">
          {error}
        </p>
      )}
      {run.approval && (
        <section className="notice" role="status" aria-labelledby="approval-heading">
          <h2 id="approval-heading">Approval needed after {run.approval.after}</h2>
          <ul>
            {run.approval.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          <div className="actions">
            <button type="button" disabled={busy} onClick={() => decide('approve')}>
              Approve and continue
            </button>
          </div>
          <label>
            Or send it back with feedback
            <textarea
              rows={3}
              value={feedback}
              onChange={(event) => setFeedback(event.target.value)}
              placeholder="What should change? The agent reads this before it tries again."
            />
          </label>
          <button
            type="button"
            className="secondary"
            disabled={busy || !feedback.trim()}
            onClick={() => decide('reject')}
          >
            Send back
          </button>
        </section>
      )}
      {run.statusReason && !run.approval && (
        <section className={run.status === 'failed' ? 'error-notice' : 'notice'} role="status">
          <h2>
            {run.status === 'needs_input'
              ? 'The agent needs an answer'
              : run.status === 'failed'
                ? 'The run failed'
                : 'Run stopped'}
          </h2>
          <Markdown text={run.statusReason} />
          {run.status === 'needs_input' && (
            <p className="muted">
              The question was posted on the issue. Answer there, then choose “Run again”.
            </p>
          )}
        </section>
      )}
      <div className="workspace-grid">
        <div className="workspace-main">
          <section className="panel">
            <div className="section-heading">
              <h2 id="stages-heading">
                Stages <span className="count">{run.stages.length}</span>
              </h2>
            </div>
            {run.stages.length ? (
              <ol className="stage-list" aria-labelledby="stages-heading">
                {run.stages.map((stage, index) => (
                  <li key={index} className={`stage stage-${stage.status}`}>
                    <div className="stage-heading">
                      <strong>
                        {stage.name}
                        {stage.attempt > 1 ? ` · attempt ${stage.attempt}` : ''}
                      </strong>
                      <Status value={stage.status} />
                      <span className="muted small">
                        <DateLabel date={stage.startedAt} /> · {duration(stage)}
                      </span>
                    </div>
                    {stage.summary && <p className="task-note">{stage.summary}</p>}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="muted empty-copy">No stage has started yet.</p>
            )}
          </section>
          <section className="panel">
            <div className="section-heading">
              <h2>Plan</h2>
              <span className="muted">
                {finishedPlan.steps.filter((step) => step.status === 'completed').length}/
                {finishedPlan.steps.length} done
              </span>
            </div>
            <PlanProgress plan={finishedPlan} title={run.title} />
          </section>
          <Changes run={run} api={api} />
          <Terminal run={run} api={api} />
          {terminal && <WebTerminal api={api} runId={run.id} />}
          <Attachments attachments={run.attachments} onOpen={(item) => setAttachmentId(item.id)} />
        </div>
        <aside className="workspace-aside">
          <section className="panel">
            <h2>Run details</h2>
            <dl className="details-list">
              <dt>Repository</dt>
              <dd>{run.repo}</dd>
              <dt>Branch</dt>
              <dd className="path">
                {run.branch} <CopyButton value={run.branch} label="branch name" />
              </dd>
              <dt>Base</dt>
              <dd className="path">{run.baseBranch ?? 'Not resolved yet'}</dd>
              <dt>Autonomy</dt>
              <dd>
                {run.policy ? run.policy.autonomy : 'Not evaluated yet'}
                {run.merge && ` · merge ${run.merge}`}
              </dd>
              {run.policy?.critical.length ? (
                <>
                  <dt>Critical</dt>
                  <dd>
                    <ul>
                      {run.policy.critical.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                  </dd>
                </>
              ) : null}
              <dt>Worktree</dt>
              <dd className="path">{run.worktreePath ?? 'None'}</dd>
              <dt>Created</dt>
              <dd>
                <DateLabel date={run.createdAt} />
              </dd>
              <dt>Run ID</dt>
              <dd className="path">
                {run.id} <CopyButton value={run.id} label="run ID" />
              </dd>
            </dl>
          </section>
          <section className="panel">
            <h2>Watch in Herdr</h2>
            <p className="muted">
              Each stage runs in its own tab of this run’s Herdr workspace. Attach from a terminal:
            </p>
            <pre className="artifact-source" tabIndex={0} aria-label="Herdr attach command">
              herdr --session {herdrSession}
            </pre>
            <CopyButton value={`herdr --session ${herdrSession}`} label="attach command" />
          </section>
        </aside>
      </div>
      {run.attachments
        .filter((attachment) => attachment.id === attachmentId)
        .map((attachment) => (
          <AttachmentPreview
            key={attachment.id}
            attachment={attachment}
            onClose={() => setAttachmentId(null)}
          />
        ))}
    </>
  );
}
