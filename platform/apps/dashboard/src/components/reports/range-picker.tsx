'use client';

import { businessDayLabel, currentBusinessDay, shiftBusinessDay } from '@/lib/grid-time';
import { Button } from '@/components/ui/button';

/**
 * A range of TRADING days, never calendar days.
 *
 * "This month" ends tonight and starts on the 1st of the trading month, so at
 * 01:30 on 1 October a manager still sees September — which is the month the
 * evening they are standing in belongs to. Spec §3.3.
 */

export interface TradingRange {
  from: string;
  to: string;
}

/** The current trading month, to date. The period a manager actually closes. */
export function currentTradingMonth(now: Date = new Date()): TradingRange {
  const to = currentBusinessDay(now);
  return { from: `${to.slice(0, 7)}-01`, to };
}

function previousTradingMonth(now: Date = new Date()): TradingRange {
  const today = currentBusinessDay(now);
  const firstOfThisMonth = `${today.slice(0, 7)}-01`;
  const lastOfPrevious = shiftBusinessDay(firstOfThisMonth, -1);
  return { from: `${lastOfPrevious.slice(0, 7)}-01`, to: lastOfPrevious };
}

function lastNights(count: number, now: Date = new Date()): TradingRange {
  const to = currentBusinessDay(now);
  return { from: shiftBusinessDay(to, -(count - 1)), to };
}

const PRESETS: Array<{ key: string; label: string; of: (now?: Date) => TradingRange }> = [
  { key: 'month', label: 'This month', of: currentTradingMonth },
  { key: 'last-month', label: 'Last month', of: previousTradingMonth },
  { key: '7', label: 'Last 7 nights', of: (now) => lastNights(7, now) },
  { key: '30', label: 'Last 30 nights', of: (now) => lastNights(30, now) },
];

export function RangePicker({
  range,
  onChange,
}: {
  range: TradingRange;
  onChange: (range: TradingRange) => void;
}): JSX.Element {
  const invalid = range.from > range.to;

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-[150px]">
          <span className="field-label">First trading night</span>
          <input
            type="date"
            value={range.from}
            max={range.to}
            onChange={(event) => onChange({ ...range, from: event.target.value })}
            className="field-input numeric py-2.5"
          />
        </label>
        <label className="min-w-[150px]">
          <span className="field-label">Last trading night</span>
          <input
            type="date"
            value={range.to}
            min={range.from}
            onChange={(event) => onChange({ ...range, to: event.target.value })}
            className="field-input numeric py-2.5"
          />
        </label>

        <div className="flex flex-wrap gap-2">
          {PRESETS.map((preset) => {
            const candidate = preset.of();
            const active = candidate.from === range.from && candidate.to === range.to;
            return (
              <Button
                key={preset.key}
                variant={active ? 'primary' : 'secondary'}
                size="md"
                onClick={() => onChange(candidate)}
              >
                {preset.label}
              </Button>
            );
          })}
        </div>
      </div>

      <p className="text-[12.5px] leading-snug text-ink-muted">
        {invalid ? (
          <span className="text-alert-deep">
            The period ends before it starts — the report cannot be read this way.
          </span>
        ) : (
          <>
            {businessDayLabel(range.from)} to {businessDayLabel(range.to)}. Trading nights run
            11:00–02:00, so a 01:30 booking counts on the night before.
          </>
        )}
      </p>
    </div>
  );
}

/** The single-night control the close-out sheet opens on. */
export function NightPicker({
  day,
  onChange,
}: {
  day: string;
  onChange: (day: string) => void;
}): JSX.Element {
  const tonight = currentBusinessDay();

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="secondary" size="md" onClick={() => onChange(shiftBusinessDay(day, -1))}>
        ‹ Previous
      </Button>
      <input
        type="date"
        value={day}
        onChange={(event) => onChange(event.target.value)}
        className="field-input numeric w-[170px] py-2.5"
        aria-label="Trading night"
      />
      <Button variant="secondary" size="md" onClick={() => onChange(shiftBusinessDay(day, 1))}>
        Next ›
      </Button>
      {day !== tonight ? (
        <Button variant="quiet" size="md" onClick={() => onChange(tonight)}>
          Back to tonight
        </Button>
      ) : null}
    </div>
  );
}
