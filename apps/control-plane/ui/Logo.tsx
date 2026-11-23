import { useEffect, useRef, useState } from 'react';

/** The Kiln mark: a brick arch with a flame burning inside it. */
export function Logo({ size = 40 }: { size?: number }) {
  return (
    <svg
      className="logo"
      width={size}
      height={size}
      viewBox="0 0 48 48"
      role="img"
      aria-label="Kiln"
    >
      <defs>
        <linearGradient id="kiln-ember" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffb347" />
          <stop offset="0.55" stopColor="#ff6a3d" />
          <stop offset="1" stopColor="#ff2e7e" />
        </linearGradient>
        <linearGradient id="kiln-body" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1d2233" />
          <stop offset="1" stopColor="#10131d" />
        </linearGradient>
      </defs>
      <rect x="1.5" y="1.5" width="45" height="45" rx="13" fill="url(#kiln-body)" />
      <rect
        x="1.5"
        y="1.5"
        width="45"
        height="45"
        rx="13"
        fill="none"
        stroke="url(#kiln-ember)"
        strokeOpacity="0.55"
      />
      <path
        className="logo-arch"
        d="M12 38V23a12 12 0 0 1 24 0v15"
        fill="none"
        stroke="url(#kiln-ember)"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
      <path d="M9.5 38h29" stroke="url(#kiln-ember)" strokeWidth="2.6" strokeLinecap="round" />
      <path
        className="logo-flame"
        d="M24 34.5c-4.2 0-6.6-2.8-6.6-6.2 0-3 2-4.6 3.2-7 .5 1.6 1.4 2.4 2.4 2.9-.2-3.2 1-6 3.4-8 .1 3.4 3.8 5 3.8 10.1 0 3.6-2.5 8.2-6.2 8.2Z"
        fill="url(#kiln-ember)"
      />
      <path
        className="logo-core"
        d="M24 34.5c-1.9 0-3.1-1.4-3.1-3.1 0-1.6 1.3-2.4 1.9-3.8.9.9 1.7 1.8 1.7 3.1.5-.4.9-1 1-1.8.5.7.6 1.4.6 2 0 1.9-1.1 3.6-2.1 3.6Z"
        fill="#fff3d6"
      />
    </svg>
  );
}

/** A number that counts up to its value when it changes. */
export function Count({ value }: { value: number }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const start = from.current;
    if (
      start === value ||
      typeof window.matchMedia !== 'function' ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      from.current = value;
      setShown(value);
      return;
    }
    const began = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - began) / 600);
      const eased = 1 - (1 - t) ** 3;
      setShown(Math.round(start + (value - start) * eased));
      if (t < 1) frame = requestAnimationFrame(tick);
      else from.current = value;
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      from.current = value;
    };
  }, [value]);
  return <>{shown}</>;
}
