'use client';

import { formatAed } from '@berelax/contracts';
import type { ReactNode } from 'react';
import { businessDayLabel, businessDayRelation } from '@/lib/grid-time';
import { Table, Td, Th, Row } from '@/components/reports/report-ui';
import type { LineUnit, ReconciliationLine, ReconciliationRecordView, StreakView } from './types';

/**
 * The verdict, the streak, and the ladder of nights behind them.
 *
 * The palette is the one the back office already uses, and the mapping is
 * load-bearing: teal is a night that matched, terracotta is one that did not,
 * oat is a night nobody has reconciled yet. A night with no sheet is NOT shown
 * as a pass — an empty cell is unknown, and unknown is exactly what it is.
 */

/* ───────────────────────── money and counts ───────────────────────── */

/**
 * A figure, rendered by its unit. `formatAed` is the ONLY place fils becomes a
 * string in this application (§3.1); a count is a count and never wears a
 * currency symbol.
 */
export function figure(value: number | null, unit: LineUnit): string {
  if (value === null) return '—';
  return unit === 'FILS' ? formatAed(value) : String(value);
}

/** Signed, and explicitly so: a manager needs to know which way to look. */
export function variance(value: number | null, unit: LineUnit): string {
  if (value === null) return '—';
  if (value === 0) return unit === 'FILS' ? formatAed(0) : '0';
  const rendered = unit === 'FILS' ? formatAed(Math.abs(value)) : String(Math.abs(value));
  return `${value > 0 ? '+' : '−'}${rendered}`;
}

/* ───────────────────────── the streak ───────────────────────── */

const BREAK_REASON: Record<string, (day: string) => string> = {
  MISMATCHED: (day) => `The run stops at ${businessDayLabel(day, true)}, which did not match.`,
  NOT_RECONCILED: (day) =>
    `The run stops at ${businessDayLabel(day, true)} — that night was never reconciled, so nobody can say it matched.`,
  NO_EARLIER_NIGHTS: () => 'That is every night reconciled so far.',
};

/**
 * The one number the pilot exists to produce, at the size it deserves.
 *
 * "Can we switch over yet?" is answered above the fold, in a sentence, before
 * any table. Everything under it explains the number rather than qualifying it.
 */
export function StreakBanner({ streak }: { streak: StreakView }): JSX.Element {
  const { consecutiveMatchedNights: run, requiredNights: needed, readyToSwitch } = streak;
  const remaining = Math.max(0, needed - run);

  return (
    <section
      className={[
        'rounded-xl border-2 px-4 py-4 sm:px-5',
        readyToSwitch ? 'border-teal-700 bg-teal-50' : 'border-line bg-white',
      ].join(' ')}
    >
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div>
          <p className="eyebrow mb-1.5">Parallel pilot · consecutive nights matched</p>
          <p className="font-serif text-[44px] leading-none text-ink numeric">
            <span className={readyToSwitch ? 'text-teal-700' : 'text-ink'}>{run}</span>
            <span className="text-ink-muted"> / {needed}</span>
          </p>
        </div>

        <p
          className={[
            'max-w-[36ch] text-[15px] leading-snug',
            readyToSwitch ? 'font-medium text-teal-900' : 'text-ink-soft',
          ].join(' ')}
        >
          {readyToSwitch
            ? 'Ready to switch over. The numbers have matched for five consecutive nights — take the decision with the owner, and keep the paper for one more week.'
            : `Not yet. ${remaining} more consecutive night${remaining === 1 ? '' : 's'} must match before the paper process can be put down.`}
        </p>
      </div>

      <div className="mt-4 grid gap-1.5 border-t border-line pt-3 text-[13px] text-ink-muted">
        {streak.lastReconciledNight === null ? (
          <p>Nothing has been reconciled yet. The pilot starts with tonight’s close-out.</p>
        ) : (
          <p>
            Last night reconciled: {businessDayLabel(streak.lastReconciledNight)}.{' '}
            {streak.brokenBy ? BREAK_REASON[streak.brokenBy.reason]?.(streak.brokenBy.businessDay) : null}
          </p>
        )}
        {streak.unreconciledNights.length > 0 ? (
          <p className="text-alert-deep">
            <strong className="font-medium">
              {streak.unreconciledNights.length} finished night
              {streak.unreconciledNights.length === 1 ? '' : 's'} not reconciled:
            </strong>{' '}
            {streak.unreconciledNights.map((day) => businessDayLabel(day, true)).join(', ')}. Until
            those are done the run cannot grow past them.
          </p>
        ) : null}
      </div>
    </section>
  );
}

/* ───────────────────────── the ladder ───────────────────────── */

/**
 * "Wed". Built here rather than sliced out of `businessDayLabel`, which formats
 * "Wed, 16 Sept" and would leave a comma hanging on the end of every cell.
 */
const weekdayFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short' });

function weekdayOf(day: string): string {
  return weekdayFormat.format(new Date(`${day}T12:00:00Z`));
}

const CELL: Record<string, string> = {
  MATCHED: 'border-teal-700 bg-teal-700 text-white',
  MATCHED_WITH_NOTE: 'border-teal-700 bg-teal-100 text-teal-900',
  MISMATCHED: 'border-alert bg-alert text-white',
  NONE: 'border-line bg-oat-light text-ink-muted',
};

const CELL_TITLE: Record<string, string> = {
  MATCHED: 'Matched',
  MATCHED_WITH_NOTE: 'Matched, with a note',
  MISMATCHED: 'Did not match',
  NONE: 'Not reconciled',
};

/**
 * The last fortnight, one cell per trading night, oldest on the left.
 *
 * A fortnight because that is the length of the pilot (§14). A night with no
 * submission gets its own colour rather than being left out, because the gap is
 * the finding — a run of matches with a hole in it is not a run.
 */
export function PilotLadder({
  nights,
  selected,
  onSelect,
}: {
  nights: Array<{ businessDay: string; verdict: string | null }>;
  selected: string;
  onSelect: (day: string) => void;
}): JSX.Element {
  return (
    <div className="flex flex-wrap gap-1.5">
      {nights.map((night) => {
        const state = night.verdict ?? 'NONE';
        const isSelected = night.businessDay === selected;
        return (
          <button
            key={night.businessDay}
            type="button"
            onClick={() => onSelect(night.businessDay)}
            title={`${businessDayLabel(night.businessDay)} — ${CELL_TITLE[state] ?? state}`}
            aria-current={isSelected ? 'date' : undefined}
            className={[
              'min-h-[44px] min-w-[52px] rounded-xl border px-2 py-1.5 text-center transition-colors',
              CELL[state] ?? CELL.NONE,
              isSelected ? 'ring-4 ring-teal-500/25' : '',
            ].join(' ')}
          >
            <span className="block text-[10px] uppercase tracking-label opacity-80">
              {weekdayOf(night.businessDay)}
            </span>
            <span className="block text-[15px] numeric">{night.businessDay.slice(8)}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ───────────────────────── the verdict ───────────────────────── */

const VERDICT_COPY: Record<string, { headline: string; tone: string; body: string }> = {
  MATCHED: {
    headline: 'Matched',
    tone: 'border-teal-700 bg-teal-50 text-teal-900',
    body: 'Every figure agreed. This night counts towards the five.',
  },
  MATCHED_WITH_NOTE: {
    headline: 'Matched, with a note',
    tone: 'border-teal-700 bg-teal-50 text-teal-900',
    body: 'Every figure agreed and the night was explained. It still counts towards the five — a note is context, not a caveat.',
  },
  MISMATCHED: {
    headline: 'Did not match',
    tone: 'border-alert bg-alert-pale text-alert-deep',
    body: 'Investigate tonight, before the next night is traded. A difference you carry forward is a difference you will never find.',
  },
};

export function VerdictPanel({
  record,
  children,
}: {
  record: ReconciliationRecordView;
  children?: ReactNode;
}): JSX.Element {
  const copy = VERDICT_COPY[record.verdict] ?? VERDICT_COPY.MISMATCHED;

  return (
    <section className="rounded-xl border border-line bg-white">
      <header className={`rounded-t-[10px] border-b-2 px-4 py-3.5 sm:px-5 ${copy?.tone ?? ''}`}>
        <p className="text-[11.5px] uppercase tracking-label opacity-80">
          {businessDayRelation(record.businessDay)} · {businessDayLabel(record.businessDay)}
        </p>
        <h2 className="font-serif text-[26px] leading-tight">{copy?.headline}</h2>
        <p className="mt-1 max-w-[62ch] text-[13.5px] leading-snug">{copy?.body}</p>
      </header>

      <div className="px-4 py-4 sm:px-5">
        <LineTable lines={record.lines} />

        {record.note ? (
          <p className="mt-4 rounded-xl border border-line bg-oat-light px-4 py-3 text-[13.5px] leading-relaxed text-ink-soft">
            <span className="eyebrow mr-2">Note</span>
            {record.note}
          </p>
        ) : null}

        <p className="mt-4 text-[12.5px] leading-relaxed text-ink-muted">
          Signed off {new Date(record.submittedAt).toLocaleString('en-AE')}.{' '}
          {record.cashToleranceFils > 0
            ? `A cash tolerance of ${formatAed(record.cashToleranceFils)} was in force and is recorded on this row.`
            : 'No cash tolerance: the drawer had to agree to the fil.'}{' '}
          {record.supersedesId
            ? 'This is a correction — the earlier attempt is still in the history below.'
            : null}
        </p>

        {children}
      </div>
    </section>
  );
}

/**
 * The comparison, line by line.
 *
 * System and paper sit next to each other with the difference between them,
 * because the question a manager is actually asking is "which way, and how
 * much" — not "did a boolean go false".
 */
export function LineTable({ lines }: { lines: ReconciliationLine[] }): JSX.Element {
  return (
    <Table
      head={
        <>
          <Th width="30%">Line</Th>
          <Th numeric>System</Th>
          <Th numeric>Paper</Th>
          <Th numeric>Difference</Th>
          <Th>Result</Th>
        </>
      }
    >
      {lines.map((line) => (
        <Row key={line.key}>
          <Td>
            <span className="block">{line.label}</span>
            <span className="mt-0.5 block text-[12px] leading-snug text-ink-muted">
              {line.compared
                ? line.toleranceFils > 0
                  ? `Tolerance ${formatAed(line.toleranceFils)}`
                  : 'Must agree exactly'
                : 'Not submitted — not compared'}
            </span>
          </Td>
          <Td numeric>{figure(line.system, line.unit)}</Td>
          <Td numeric muted={!line.compared}>
            {figure(line.paper, line.unit)}
          </Td>
          <Td numeric>
            <span
              className={
                line.difference !== null && line.difference !== 0 && !line.withinTolerance
                  ? 'text-alert-deep'
                  : 'text-ink'
              }
            >
              {variance(line.difference, line.unit)}
            </span>
          </Td>
          <Td>
            {!line.compared ? (
              <span className="text-[13px] text-ink-muted">not checked</span>
            ) : line.withinTolerance ? (
              <span className="text-[13px] text-teal-700">agrees</span>
            ) : (
              <span className="text-[13px] font-medium text-alert-deep">out</span>
            )}
          </Td>
        </Row>
      ))}
    </Table>
  );
}

/** What to do about a line that is out, in the API's own words. */
export function FindingList({ failing }: { failing: ReconciliationLine[] }): JSX.Element | null {
  if (failing.length === 0) return null;

  return (
    <ul className="mt-4 grid gap-2.5">
      {failing.map((line) => (
        <li
          key={line.key}
          className="rounded-xl border-2 border-alert bg-alert-pale px-4 py-3 text-[13.5px] leading-relaxed text-alert-deep"
        >
          <strong className="font-semibold">
            {line.label} is out by {variance(line.difference, line.unit)}.
          </strong>{' '}
          {line.basis}
        </li>
      ))}
    </ul>
  );
}
