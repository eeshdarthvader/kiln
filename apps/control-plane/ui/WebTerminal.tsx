import { useEffect, useRef, useState } from 'react';
import { errorText, type Api } from './api';
import '@xterm/xterm/css/xterm.css';

type Phase = 'idle' | 'connecting' | 'open' | 'closed';

/** A shell on the factory host, starting in the run's worktree. xterm loads on first use. */
export function WebTerminal({ api, runId }: { api: Api; runId: string }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState('');
  const host = useRef<HTMLDivElement>(null);
  const stop = useRef<(() => void) | null>(null);
  const cancelled = useRef(false);
  const [reader, setReader] = useState(false);

  useEffect(() => () => stop.current?.(), []);

  async function open() {
    if (!host.current) return;
    setPhase('connecting');
    setMessage('');
    cancelled.current = false;
    stop.current = () => {
      cancelled.current = true;
      setPhase('closed');
      setMessage('Cancelled.');
    };
    try {
      const [{ Terminal }, { FitAddon }, { ticket }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
        api<{ ticket: string; cwd: string }>('/terminal/tickets', 'POST', { runId }),
      ]);
      if (cancelled.current) return;
      const term = new Terminal({
        screenReaderMode: reader,
        cursorBlink: true,
        fontSize: 13,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        theme: { background: '#05070b', foreground: '#d8e4dd', cursor: '#ff6a3d' },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host.current);
      fit.fit();
      const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const socket = new WebSocket(
        `${scheme}://${window.location.host}/v1/terminal?ticket=${ticket}`,
      );
      socket.binaryType = 'arraybuffer';
      const encoder = new TextEncoder();
      const sendSize = () => {
        if (socket.readyState === WebSocket.OPEN)
          socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      };
      socket.onopen = () => {
        setPhase('open');
        sendSize();
        term.focus();
      };
      socket.onmessage = (event) => term.write(new Uint8Array(event.data as ArrayBuffer));
      socket.onclose = (event) => {
        setPhase('closed');
        setMessage(event.reason || 'The terminal disconnected.');
        stop.current = null;
        observer.disconnect();
        term.dispose();
      };
      const input = term.onData((data) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(encoder.encode(data));
      });
      const observer = new ResizeObserver(() => {
        fit.fit();
        sendSize();
      });
      observer.observe(host.current);
      stop.current = () => {
        input.dispose();
        socket.close();
      };
    } catch (reason) {
      setPhase('closed');
      setMessage(errorText(reason));
    }
  }

  return (
    <section className="panel">
      <div className="section-heading">
        <h2>Shell</h2>
        {phase === 'open' || phase === 'connecting' ? (
          <button type="button" className="secondary" onClick={() => stop.current?.()}>
            Close shell
          </button>
        ) : (
          <button type="button" onClick={() => void open()}>
            {phase === 'closed' ? 'Reopen shell' : 'Open shell'}
          </button>
        )}
      </div>
      {phase === 'idle' && (
        <p className="muted empty-copy">
          Opens a shell on the factory host in this run’s worktree, to fix things while the agent
          works.
        </p>
      )}
      <p className="muted small" role="status">
        {phase === 'connecting' ? 'Connecting…' : phase === 'open' ? 'Connected.' : message}
      </p>
      {phase === 'idle' || phase === 'closed' ? (
        <label className="check">
          <input
            type="checkbox"
            checked={reader}
            onChange={(event) => setReader(event.target.checked)}
          />
          Screen reader mode
        </label>
      ) : (
        <p className="muted small" id="terminal-hint">
          Keys go to the shell, including Tab. Use “Close shell” to leave.
        </p>
      )}
      <div
        className="web-terminal"
        ref={host}
        role="group"
        aria-label="Terminal"
        aria-describedby="terminal-hint"
        hidden={phase === 'idle' || phase === 'closed'}
      />
    </section>
  );
}
