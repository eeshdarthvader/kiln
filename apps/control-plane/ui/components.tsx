import { useEffect, useId, useRef, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Plan } from './types';

export function Status({ value, label }: { value: string; label?: string }) {
  return <span className={`status status-${value}`}>{label ?? value.replaceAll('_', ' ')}</span>;
}

export function DateLabel({ date }: { date: string }) {
  return (
    <time dateTime={date} title={new Date(date).toLocaleString()}>
      {new Date(date).toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })}
    </time>
  );
}

export function safeUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        components={{
          img: () => null,
          a: ({ href, children }) => {
            const url = href ? safeUrl(href) : undefined;
            return url ? (
              <a href={url} target="_blank" rel="noreferrer">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export function PlanProgress({ plan, title }: { plan: Plan; title: string }) {
  if (!plan.steps.length) return <p className="muted small">Plan not published yet.</p>;
  return (
    <div
      className="pipeline-scroll"
      role="region"
      aria-label={`${title} plan progress`}
      tabIndex={0}
    >
      <ol className="pipeline">
        {plan.steps.map((step, index) => (
          <li
            key={step.id}
            className={`step step-${step.status}`}
            aria-current={step.status === 'running' ? 'step' : undefined}
            title={`${step.text}: ${step.status}`}
          >
            <span className="step-bubble" aria-hidden="true">
              {step.status === 'completed' ? '✓' : step.status === 'running' ? '●' : index + 1}
            </span>
            <span>{step.text}</span>
            <span className="sr-only">{step.status}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function Modal({
  title,
  children,
  onClose,
  wide = false,
  open = true,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  open?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    const element = dialog.current;
    element?.showModal();
    document.body.style.overflow = 'hidden';
    return () => {
      element?.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, [open]);
  return (
    <dialog
      ref={dialog}
      className={`modal ${wide ? 'modal-wide' : ''}`}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="modal-heading">
        <h2 id={titleId}>{title}</h2>
        <button className="secondary compact" type="button" onClick={onClose}>
          Close
        </button>
      </header>
      {children}
    </dialog>
  );
}
