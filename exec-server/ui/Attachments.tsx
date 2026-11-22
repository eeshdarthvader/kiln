import { useState } from 'react';
import type { Attachment } from './types';
import { DateLabel, Markdown, safeUrl } from './components';

function Reference({ url }: { url: string }) {
  const href = safeUrl(url);
  return href ? (
    <a className="reference-link" href={href} target="_blank" rel="noreferrer">
      {url} ↗
    </a>
  ) : (
    <p className="error">This reference does not have a valid HTTP or HTTPS URL.</p>
  );
}

export function AttachmentContent({ attachment }: { attachment: Attachment }) {
  const [source, setSource] = useState(false);
  switch (attachment.kind) {
    case 'artifact':
      return (
        <>
          <div className="artifact-toolbar">
            <span className="muted">{attachment.mediaType}</span>
            {attachment.mediaType === 'text/markdown' && (
              <button
                type="button"
                className="secondary compact"
                aria-pressed={source}
                onClick={() => {
                  setSource(!source);
                }}
              >
                {source ? 'Show preview' : 'Show source'}
              </button>
            )}
          </div>
          <div>
            {attachment.mediaType === 'text/markdown' && !source ? (
              <Markdown text={attachment.content} />
            ) : (
              <pre className="artifact-source">{attachment.content}</pre>
            )}
          </div>
        </>
      );
    case 'decision':
      return (
        <>
          <h3>Summary</h3>
          <Markdown text={attachment.summary} />
          <h3 className="content-subheading">Rationale</h3>
          <Markdown text={attachment.rationale} />
          {attachment.options?.length ? (
            <>
              <h3 className="content-subheading">Options considered</h3>
              <ul>
                {attachment.options.map((option) => (
                  <li key={option}>{option}</li>
                ))}
              </ul>
            </>
          ) : null}
          {(attachment.reversibility || attachment.blastRadius) && (
            <p className="muted small">
              {attachment.reversibility &&
                `Reversibility: ${attachment.reversibility.replace('_', ' ')}`}
              {attachment.reversibility && attachment.blastRadius && ' · '}
              {attachment.blastRadius && `Blast radius: ${attachment.blastRadius}`}
            </p>
          )}
        </>
      );
    case 'evidence':
      return (
        <>
          {attachment.text && <Markdown text={attachment.text} />}
          {attachment.url && <Reference url={attachment.url} />}
        </>
      );
    case 'context_reference':
      return (
        <>
          {attachment.description && <Markdown text={attachment.description} />}
          <Reference url={attachment.url} />
        </>
      );
  }
}

export function Attachments({
  attachments,
  onOpen,
}: {
  attachments: Attachment[];
  onOpen: (attachment: Attachment) => void;
}) {
  return (
    <section className="panel">
      <div className="section-heading">
        <h2>
          Attachments <span className="count">{attachments.length}</span>
        </h2>
      </div>
      <p className="muted small">
        Each attachment is retained as published. Revisions appear as new attachments.
      </p>
      {attachments.length ? (
        <ul className="artifact-list">
          {[...attachments].reverse().map((attachment) => {
            return (
              <li key={attachment.id}>
                <button type="button" className="artifact-row" onClick={() => onOpen(attachment)}>
                  <span>
                    <strong>{attachment.title}</strong>
                    <small>
                      {attachment.kind.replaceAll('_', ' ')} · {attachment.stage} ·{' '}
                      <DateLabel date={attachment.createdAt} />
                    </small>
                  </span>
                  <span>View ↗</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="muted empty-copy">No attachments published yet.</p>
      )}
    </section>
  );
}
