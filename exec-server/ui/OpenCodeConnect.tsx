import { useEffect, useState } from 'react';
import type { OpenCodeConnection } from '../src/shared/types';
import { errorText, type Api } from './api';
import { Modal } from './components';

export function OpenCodeConnect({
  api,
  sessionUrl,
  onClose,
}: {
  api: Api;
  sessionUrl: string;
  onClose: () => void;
}) {
  const [connection, setConnection] = useState<OpenCodeConnection | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let canceled = false;
    setConnection(null);
    setError('');
    void api<OpenCodeConnection>('/opencode/connection').then(
      (value) => {
        if (!canceled) setConnection(value);
      },
      (cause) => {
        if (!canceled) setError(errorText(cause));
      },
    );
    return () => {
      canceled = true;
    };
  }, [api]);
  return (
    <Modal title="Open in OpenCode" onClose={onClose}>
      <p className="muted">Already signed in? Go straight to step 2.</p>
      <section className="opencode-step">
        <h3>Step 1: Log in with password</h3>
        <p className="muted">
          Open the login page and sign in as <strong>opencode</strong>.
        </p>
        {connection ? (
          <>
            <p>
              Password: <code className="path">{connection.password}</code>
            </p>
            <a
              className="reference-link"
              href={connection.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open OpenCode login ↗
            </a>
          </>
        ) : error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : (
          <p className="muted" role="status">
            Loading login details…
          </p>
        )}
      </section>
      <section className="opencode-step">
        <h3>Step 2: Open the task session</h3>
        <p className="muted">After signing in, return here and follow the session link.</p>
        <a className="reference-link" href={sessionUrl} target="_blank" rel="noopener noreferrer">
          Open task session ↗
        </a>
      </section>
    </Modal>
  );
}
