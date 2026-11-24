import { useState } from 'react';
import { errorText, runPath, type Api } from './api';
import { DateLabel, useToast } from './components';
import type { Run } from './types';

/** Sends a note to the agent that is working, and keeps a record of what was sent. */
export function SteerBox({
  run,
  api,
  onUpdate,
}: {
  run: Run;
  api: Api;
  onUpdate: (run: Run) => void;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const toast = useToast();
  const active = run.status === 'running';
  const notes = run.notes ?? [];
  if (!active && !notes.length) return null;

  const send = () => {
    if (!note.trim() || busy) return;
    setBusy(true);
    setError('');
    api<Run>(`${runPath(run.id)}/steer`, 'POST', { note })
      .then((updated) => {
        setNote('');
        onUpdate(updated);
        toast('Note sent to the agent.');
      })
      .catch((reason: unknown) => setError(errorText(reason)))
      .finally(() => setBusy(false));
  };
  return (
    <section className="panel" aria-labelledby="steer-heading">
      <div className="section-heading">
        <h2 id="steer-heading">Steer the agent</h2>
      </div>
      {active ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
        >
          <label>
            Note for the agent
            <textarea
              rows={3}
              maxLength={1000}
              value={note}
              placeholder="For example: use the existing helper instead of adding a new one."
              onChange={(event) => setNote(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  send();
                }
              }}
              aria-describedby="steer-hint"
            />
          </label>
          <p className="muted small" id="steer-hint">
            The note is typed into the agent’s terminal as one message. It reads it at its next
            opportunity, so it may not change what it is doing this second. Press Ctrl or Cmd with
            Enter to send.
          </p>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="form-actions">
            <button type="submit" disabled={busy || !note.trim()}>
              {busy ? 'Sending…' : 'Send note'}
            </button>
          </div>
        </form>
      ) : (
        <p className="muted small">The agent is not working right now, so notes can’t be sent.</p>
      )}
      {notes.length > 0 && (
        <>
          <h3 className="steer-history-title">Sent so far</h3>
          <ol className="steer-history">
            {notes
              .slice()
              .reverse()
              .map((item) => (
                <li key={item.sentAt + item.text}>
                  <p>{item.text}</p>
                  <p className="muted small">
                    During {item.stage} · <DateLabel date={item.sentAt} />
                  </p>
                </li>
              ))}
          </ol>
        </>
      )}
    </section>
  );
}
