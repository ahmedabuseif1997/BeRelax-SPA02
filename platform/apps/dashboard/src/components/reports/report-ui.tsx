'use client';

import { formatAed } from '@berelax/contracts';
import { useEffect, useState, type ReactNode } from 'react';
import { Button, Spinner } from '@/components/ui/button';
import { ErrorNotice } from '@/components/ui/error-notice';
import { failureMessage, relativeTime, type ReportState } from '@/lib/use-report';

/**
 * The parts every report on this page is built from.
 *
 * No charting library. Where a number reads better as a bar it is drawn with a
 * div and a width, because a dependency is a decision somebody else gets to
 * make and a 40-line `<Bar>` is not worth 90 kB of JavaScript on a page four
 * people open.
 *
 * The palette is the one the rest of the back office uses: teal for money the
 * business earned, gold for money it is holding on somebody else's behalf, oat
 * for money that never touched it. That mapping is load-bearing — §9.1's three
 * lines are three colours here and they are never mixed.
 */

/* ───────────────────────────── layout ───────────────────────────── */

export function Panel({
  title,
  hint,
  right,
  children,
}: {
  title: string;
  hint?: string;
  right?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="rounded-xl border border-line bg-white">
      <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-line px-4 py-3 sm:px-5">
        <h2 className="font-serif text-[19px] leading-tight text-ink">{title}</h2>
        {hint ? <p className="text-[12.5px] leading-snug text-ink-muted">{hint}</p> : null}
        {right ? <div className="ml-auto">{right}</div> : null}
      </header>
      <div className="px-4 py-4 sm:px-5">{children}</div>
    </section>
  );
}

/** The quiet paragraph under a report that says what its numbers mean. */
export function Basis({ children }: { children: ReactNode }): JSX.Element {
  return (
    <p className="rounded-xl border border-line bg-oat-light px-4 py-3 text-[13px] leading-relaxed text-ink-muted">
      {children}
    </p>
  );
}

export function Tiles({ children }: { children: ReactNode }): JSX.Element {
  return <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{children}</div>;
}

type Tone = 'ink' | 'revenue' | 'payable' | 'outside' | 'alert';

const TONE: Record<Tone, string> = {
  ink: 'text-ink',
  revenue: 'text-teal-700',
  payable: 'text-gold-deep',
  outside: 'text-ink-muted',
  alert: 'text-alert-deep',
};

/**
 * A money figure. `formatAed` is the ONLY place fils becomes a string in this
 * application (§3.1), and `—` rather than `AED 0.00` when there is genuinely no
 * number: a dash is unknown, a zero is a claim.
 */
export function Figure({
  label,
  fils,
  sub,
  tone = 'ink',
}: {
  label: string;
  fils: number | null | undefined;
  sub?: string;
  tone?: Tone;
}): JSX.Element {
  return (
    <div className="rounded-xl border border-line bg-white px-4 py-4">
      <p className="text-[11.5px] uppercase tracking-label text-ink-muted">{label}</p>
      <p className={`mt-1 font-serif text-[27px] leading-none numeric ${TONE[tone]}`}>
        {fils === null || fils === undefined ? '—' : formatAed(fils)}
      </p>
      {sub ? <p className="mt-1.5 text-[12.5px] leading-snug text-ink-muted">{sub}</p> : null}
    </div>
  );
}

export function Count({
  label,
  value,
  sub,
  tone = 'ink',
}: {
  label: string;
  value: number | null | undefined;
  sub?: string;
  tone?: Tone;
}): JSX.Element {
  return (
    <div className="rounded-xl border border-line bg-white px-4 py-4">
      <p className="text-[11.5px] uppercase tracking-label text-ink-muted">{label}</p>
      <p className={`mt-1 font-serif text-[27px] leading-none numeric ${TONE[tone]}`}>
        {value ?? '—'}
      </p>
      {sub ? <p className="mt-1.5 text-[12.5px] leading-snug text-ink-muted">{sub}</p> : null}
    </div>
  );
}

/* ───────────────────────────── bars ───────────────────────────── */

export const SERIES = {
  /** Money the business earned. */
  revenue: 'bg-teal-700',
  /** Money it is holding for a therapist. A pass-through, never revenue. §9.1. */
  payable: 'bg-gold',
  /** Money that never entered the business at all. §9.2. */
  outside: 'bg-oat-dark',
  neutral: 'bg-teal-500',
} as const;

export type Series = keyof typeof SERIES;

/**
 * One horizontal bar, drawn with a div. `scale` is the largest value in the
 * series, passed in rather than derived per row, so every bar on a panel is
 * measured against the same axis — bars with private scales are a lie told with
 * a picture.
 */
export function Bar({
  value,
  scale,
  series = 'revenue',
  height = 12,
  title,
}: {
  value: number;
  scale: number;
  series?: Series;
  height?: number;
  title?: string;
}): JSX.Element {
  const width = scale > 0 ? Math.max(0, Math.min(100, (value / scale) * 100)) : 0;
  return (
    <div
      className="w-full overflow-hidden rounded-full bg-oat"
      style={{ height }}
      title={title}
      role="presentation"
    >
      <div className={`h-full rounded-full ${SERIES[series]}`} style={{ width: `${width}%` }} />
    </div>
  );
}

/** A 0–100 % meter. Null reads as "no roster", never as an empty bar at zero. */
export function Meter({ pct }: { pct: number | null }): JSX.Element {
  if (pct === null) {
    return <span className="text-[12.5px] text-ink-muted">no roster</span>;
  }
  return (
    <div className="flex items-center gap-2">
      <div className="h-2.5 w-full min-w-[60px] overflow-hidden rounded-full bg-oat">
        <div
          className="h-full rounded-full bg-teal-600"
          style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
        />
      </div>
      <span className="w-[52px] shrink-0 text-right text-[13px] text-ink numeric">
        {pct.toFixed(1)}%
      </span>
    </div>
  );
}

/** A legend entry: the swatch, the name, and the sentence the API sent with it. */
export function LegendLine({
  series,
  name,
  meaning,
}: {
  series: Series;
  name: string;
  meaning: string;
}): JSX.Element {
  return (
    <li className="flex gap-2.5">
      <span className={`mt-[6px] h-2.5 w-2.5 shrink-0 rounded-full ${SERIES[series]}`} />
      <span className="text-[13px] leading-snug text-ink-muted">
        <strong className="font-medium text-ink">{name}</strong> — {meaning}
      </span>
    </li>
  );
}

export function Legend({ children }: { children: ReactNode }): JSX.Element {
  return <ul className="grid gap-2">{children}</ul>;
}

/* ───────────────────────────── tables ───────────────────────────── */

export function Table({
  head,
  children,
}: {
  head: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="-mx-4 overflow-x-auto px-4 sm:-mx-5 sm:px-5">
      <table className="w-full min-w-[640px] border-collapse text-[14px]">
        <thead>
          <tr className="border-b border-line text-left text-[11.5px] uppercase tracking-label text-ink-muted">
            {head}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Th({
  children,
  numeric = false,
  width,
}: {
  children: ReactNode;
  numeric?: boolean;
  width?: string;
}): JSX.Element {
  return (
    <th
      scope="col"
      style={width ? { width } : undefined}
      className={`py-2.5 pr-4 font-medium ${numeric ? 'text-right' : ''}`}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  numeric = false,
  muted = false,
}: {
  children: ReactNode;
  numeric?: boolean;
  muted?: boolean;
}): JSX.Element {
  return (
    <td
      className={[
        'py-2.5 pr-4 align-middle',
        numeric ? 'text-right numeric' : '',
        muted ? 'text-ink-muted' : 'text-ink',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </td>
  );
}

export function Row({ children, total = false }: { children: ReactNode; total?: boolean }): JSX.Element {
  return (
    <tr
      className={
        total
          ? 'border-t-2 border-line-strong bg-oat-light font-medium'
          : 'border-b border-line last:border-b-0'
      }
    >
      {children}
    </tr>
  );
}

export function EmptyRow({ span, children }: { span: number; children: ReactNode }): JSX.Element {
  return (
    <tr>
      <td colSpan={span} className="py-8 text-center text-[14px] text-ink-muted">
        {children}
      </td>
    </tr>
  );
}

/* ─────────────────────── degrade, don't lie ─────────────────────── */

/**
 * §12.2, for the back office. When a refresh fails the figures below stay on
 * screen with their age stamped on them; they are not replaced by zeros and
 * they are not blanked. A manager reading last night's close-out over a bad
 * connection needs to know the number is twenty minutes old — not to be shown
 * a fresh-looking AED 0.00.
 */
export function ReportStaleBanner({
  lastSuccessAt,
  error,
  onRetry,
}: {
  lastSuccessAt: number | null;
  error: unknown;
  onRetry: () => void;
}): JSX.Element {
  const [, setTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 15_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border-2 border-alert bg-alert px-4 py-3 text-white"
    >
      <svg
        viewBox="0 0 24 24"
        className="h-5 w-5 flex-none"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      >
        <path d="M12 9v4M12 17h.01" strokeLinecap="round" />
        <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      </svg>
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-semibold leading-tight">
          These figures are old — they have not been checked against the system
        </p>
        <p className="text-[13.5px] leading-snug opacity-95">
          {failureMessage(error)} Last read {relativeTime(lastSuccessAt)}. Nothing below has been
          invented, but do not count a till against it until it refreshes.
        </p>
      </div>
      <Button
        variant="secondary"
        size="md"
        className="border-white bg-white/95 text-alert-deep hover:bg-white"
        onClick={onRetry}
      >
        Try again
      </Button>
    </div>
  );
}

/**
 * The one place a report decides what to render.
 *
 * Nothing at all + a failure is an error notice, never a page of zeros. Real
 * figures + a failure is the figures, banner first. The order is the whole
 * behaviour: the warning is above the numbers, not beside them.
 */
export function ReportFrame<T>({
  state,
  children,
}: {
  state: ReportState<T>;
  children: (data: T) => ReactNode;
}): JSX.Element {
  if (state.unavailable || (state.error !== null && state.data === null)) {
    return (
      <div className="grid gap-4">
        <ErrorNotice error={state.error} onRetry={state.refresh} retryLabel="Read it again" />
        <p className="text-[13.5px] leading-snug text-ink-muted">
          Nothing is shown rather than zeros. An empty report that says why is safer than a
          confident one that is wrong.
        </p>
      </div>
    );
  }

  if (state.data === null) {
    return (
      <div className="flex items-center gap-3 py-10 text-ink-muted">
        <Spinner />
        <span className="text-[15px]">Reading the books…</span>
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      {state.stale ? (
        <ReportStaleBanner
          lastSuccessAt={state.lastSuccessAt}
          error={state.error}
          onRetry={state.refresh}
        />
      ) : null}
      {children(state.data)}
    </div>
  );
}
