import { useEffect, useId, useRef, type CSSProperties, type ReactNode } from 'react';
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

const stepLabel: Record<string, string> = {
  pending: 'Waiting',
  running: 'In progress',
  completed: 'Done',
};

export function PlanProgress({ plan, title }: { plan: Plan; title: string }) {
  if (!plan.steps.length) return <p className="muted small">Plan not published yet.</p>;
  const done = plan.steps.filter((step) => step.status === 'completed').length;
  const percent = Math.round((done / plan.steps.length) * 100);
  const finished = done === plan.steps.length;
  return (
    <div
      className={`plan ${finished ? 'plan-finished' : ''}`}
      role="region"
      aria-label={`${title} plan progress`}
    >
      <div className="plan-meter-row">
        <div
          className="plan-meter"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={plan.steps.length}
          aria-valuenow={done}
          aria-label="Plan steps completed"
        >
          <span style={{ width: `${percent}%` }} />
        </div>
        <span className="plan-percent">{percent}%</span>
      </div>
      <ol className="plan-steps">
        {plan.steps.map((step, index) => (
          <li
            key={step.id}
            className={`plan-step plan-${step.status}`}
            style={{ '--i': index } as CSSProperties}
            aria-current={step.status === 'running' ? 'step' : undefined}
          >
            <span className="plan-node" aria-hidden="true">
              {step.status === 'completed' ? (
                <svg viewBox="0 0 16 16" width="14" height="14">
                  <path
                    d="M3.5 8.5l3 3 6-7"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ) : step.status === 'running' ? (
                <span className="plan-spin" />
              ) : (
                index + 1
              )}
            </span>
            <span className="plan-text">{step.text}</span>
            <span className="plan-state">{stepLabel[step.status] ?? step.status}</span>
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
