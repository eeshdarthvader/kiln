import { useState } from 'react';
import { errorText, type Api } from './api';
import { Modal } from './components';
import type { Run } from './types';

export function AddIssue({
  api,
  onClose,
  onCreated,
}: {
  api: Api;
  onClose: () => void;
  onCreated: (run: Run) => void;
}) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="Add an issue" onClose={onClose}>
      <p className="muted">
        Paste a GitHub issue URL (or a ticket URL from a configured tracker). The factory starts a
        run for it, or restarts the issue’s stopped run. The repository does not need to be on the
        watch list, but the machine’s <span className="path">gh</span> login must be able to push to
        it.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setError('');
          api<Run>('/runs', 'POST', { issueUrl: url.trim() })
            .then(onCreated)
            .catch((reason: unknown) => setError(errorText(reason)))
            .finally(() => setBusy(false));
        }}
      >
        <label>
          Issue URL
          <input
            autoFocus
            required
            type="url"
            inputMode="url"
            spellCheck={false}
            placeholder="https://github.com/owner/repo/issues/12"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" disabled={busy || !url.trim()}>
            {busy ? 'Starting…' : 'Start run'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
