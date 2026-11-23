import { useEffect, useState } from 'react';
import { errorText, runPath, type Api } from './api';
import { safeUrl } from './components';
import type { Run } from './types';

interface FileChange {
  path: string;
  oldPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  binary: boolean;
  patch: string;
  truncated: boolean;
}
interface Check {
  name: string;
  state: 'pass' | 'fail' | 'pending' | 'skipped';
  url?: string;
}
interface ChangesResult {
  source: 'pull_request' | 'worktree' | 'none';
  files: FileChange[];
  truncated: boolean;
  checks: Check[];
  note?: string;
}

const checkWord = { pass: 'Passed', fail: 'Failed', pending: 'Running', skipped: 'Skipped' };
const sourceText = {
  pull_request: 'From the pull request',
  worktree: 'Live from the run’s worktree, including uncommitted edits',
  none: '',
};

interface Line {
  kind: 'hunk' | 'add' | 'del' | 'ctx';
  text: string;
  oldNo?: number;
  newNo?: number;
}

function lines(patch: string): Line[] {
  let oldNo = 0;
  let newNo = 0;
  return patch.split('\n').map((text): Line => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(text);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      return { kind: 'hunk', text };
    }
    if (text.startsWith('+')) return { kind: 'add', text, newNo: newNo++ };
    if (text.startsWith('-')) return { kind: 'del', text, oldNo: oldNo++ };
    return { kind: 'ctx', text, oldNo: oldNo++, newNo: newNo++ };
  });
}

function FileDiff({
  file,
  open,
  onToggle,
}: {
  file: FileChange;
  open: boolean;
  onToggle: () => void;
}) {
  const total = file.additions + file.deletions;
  const addShare = total ? Math.round((file.additions / total) * 5) : 0;
  return (
    <li className={`diff-file diff-${file.status}`}>
      <button type="button" className="diff-head" aria-expanded={open} onClick={onToggle}>
        <span className="diff-chevron" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span className="diff-path">
          {file.status === 'renamed' && file.oldPath ? `${file.oldPath} → ` : ''}
          {file.path}
        </span>
        <span className="diff-status">{file.status}</span>
        <span className="diff-counts">
          <span className="diff-add">+{file.additions}</span>{' '}
          <span className="diff-del">−{file.deletions}</span>
        </span>
        <span className="diff-bar" aria-hidden="true">
          {Array.from({ length: 5 }, (_, index) => (
            <i
              key={index}
              className={total === 0 ? '' : index < addShare ? 'bar-add' : 'bar-del'}
            />
          ))}
        </span>
      </button>
      {open &&
        (file.binary ? (
          <p className="muted small diff-note">Binary file; no text diff.</p>
        ) : file.patch ? (
          <div
            className="diff-body"
            role="region"
            aria-label={`Changes in ${file.path}`}
            tabIndex={0}
          >
            <table>
              <tbody>
                {lines(file.patch).map((line, index) => (
                  <tr key={index} className={`line line-${line.kind}`}>
                    <td className="no" aria-hidden="true">
                      {line.oldNo ?? ''}
                    </td>
                    <td className="no" aria-hidden="true">
                      {line.newNo ?? ''}
                    </td>
                    <td className="code">
                      <span className="sr-only">
                        {line.kind === 'add' ? 'Added: ' : line.kind === 'del' ? 'Removed: ' : ''}
                      </span>
                      {line.text || ' '}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {file.truncated && (
              <p className="muted small diff-note">
                Diff cut short. Open the pull request for the rest.
              </p>
            )}
          </div>
        ) : (
          <p className="muted small diff-note">No content changes (mode or rename only).</p>
        ))}
    </li>
  );
}

/** What the run has changed, with the pull request's checks beside it. */
export function Changes({ run, api }: { run: Run; api: Api }) {
  const [result, setResult] = useState<ChangesResult | null>(null);
  const [error, setError] = useState('');
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const active = run.status === 'running';
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api<ChangesResult>(`${runPath(run.id)}/changes`)
        .then((value) => {
          if (cancelled) return;
          setResult(value);
          setError('');
          // Open the first few files of a small diff the first time it loads.
          setOpened((previous) =>
            previous.size || value.files.length > 6
              ? previous
              : new Set(value.files.slice(0, 3).map((file) => file.path)),
          );
        })
        .catch((reason: unknown) => !cancelled && setError(errorText(reason)));
    void load();
    if (!active) return () => void (cancelled = true);
    const timer = setInterval(() => void load(), 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [api, run.id, run.updatedAt, run.prState, active]);

  const files = result?.files ?? [];
  const added = files.reduce((sum, file) => sum + file.additions, 0);
  const removed = files.reduce((sum, file) => sum + file.deletions, 0);
  const allOpen = files.length > 0 && files.every((file) => opened.has(file.path));
  const prUrl = run.prUrl ? safeUrl(run.prUrl) : undefined;
  const failing = result?.checks.filter((check) => check.state === 'fail').length ?? 0;
  return (
    <section className="panel" aria-labelledby="changes-heading">
      <div className="section-heading">
        <h2 id="changes-heading">
          Changes <span className="count">{files.length}</span>
        </h2>
        {files.length > 0 && (
          <button
            type="button"
            className="secondary compact"
            onClick={() => setOpened(allOpen ? new Set() : new Set(files.map((file) => file.path)))}
          >
            {allOpen ? 'Collapse all' : 'Expand all'}
          </button>
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!result && !error && <p className="muted">Loading changes…</p>}
      {result && (
        <>
          <p className="muted small" role="status">
            {files.length
              ? `${files.length} file${files.length === 1 ? '' : 's'} · +${added} −${removed}. `
              : ''}
            {sourceText[result.source]}
            {result.note && ` ${result.note}`}
            {prUrl && files.length > 0 && (
              <>
                {' '}
                <a href={`${prUrl}/files`} target="_blank" rel="noreferrer">
                  Review on GitHub ↗
                </a>
              </>
            )}
          </p>
          {result.checks.length > 0 && (
            <ul className="checks" aria-label={`Checks, ${failing} failing`}>
              {result.checks.map((check) => {
                const url = check.url ? safeUrl(check.url) : undefined;
                const body = (
                  <>
                    <span className="check-mark" aria-hidden="true" />
                    {check.name}: {checkWord[check.state]}
                  </>
                );
                return (
                  <li key={check.name} className={`check-${check.state}`}>
                    {url ? (
                      <a href={url} target="_blank" rel="noreferrer">
                        {body}
                      </a>
                    ) : (
                      body
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {files.length > 0 && (
            <ul className="diff-list">
              {files.map((file) => (
                <FileDiff
                  key={file.path}
                  file={file}
                  open={opened.has(file.path)}
                  onToggle={() =>
                    setOpened((previous) => {
                      const next = new Set(previous);
                      if (!next.delete(file.path)) next.add(file.path);
                      return next;
                    })
                  }
                />
              ))}
            </ul>
          )}
          {result.truncated && (
            <p className="muted small">
              Only the first files are shown. Open the pull request for the rest.
            </p>
          )}
        </>
      )}
    </section>
  );
}
