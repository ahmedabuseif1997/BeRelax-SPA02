'use client';

import { useState } from 'react';
import { AppShell } from '@/components/app-shell';
import { AttributionReport } from '@/components/reports/attribution-report';
import { DailyCloseOut } from '@/components/reports/daily-close-out';
import { RevenueReport } from '@/components/reports/revenue-report';
import {
  RangePicker,
  currentTradingMonth,
  type TradingRange,
} from '@/components/reports/range-picker';
import { TherapistReport } from '@/components/reports/therapist-report';
import { TipsReport } from '@/components/reports/tips-report';
import type { ReportGroupBy } from '@/lib/api-types';
import { currentBusinessDay } from '@/lib/grid-time';

/**
 * MANAGER+ only, and route-guarded rather than link-hidden alone: a receptionist
 * who types /reports is sent back to the grid, and the API refuses all five
 * endpoints again with 403 INSUFFICIENT_ROLE. §6.4 draws this line on purpose —
 * the person handling cash all evening is not the person auditing it.
 *
 * The close-out sheet is the landing view because it is the only one of the five
 * that somebody is standing at a till waiting for. The other four are questions
 * asked in daylight.
 *
 * Every figure on every tab is integer fils on the wire and passes through
 * `formatAed` exactly once, at the point it is drawn (§3.1); every period is a
 * TRADING night, so the 01:30 booking counts against the night before (§3.3).
 * And if the API cannot be reached, each tab keeps its last real figures with a
 * banner and a timestamp rather than falling back to zeros (§12.2) — "the spa
 * took nothing on Tuesday" is a sentence somebody acts on.
 */

type Tab = 'close-out' | 'revenue' | 'therapists' | 'tips' | 'channels';

const TABS: Array<{ key: Tab; label: string; hint: string }> = [
  { key: 'close-out', label: 'Close-out', hint: 'One night, and what should be in the till' },
  { key: 'revenue', label: 'Revenue', hint: 'What the business earned, over time' },
  { key: 'therapists', label: 'Therapists', hint: 'Sessions, roster and utilisation' },
  { key: 'tips', label: 'Tips', hint: 'Earned by mode, and what is still owed' },
  { key: 'channels', label: 'Channels', hint: 'Where the guests came from' },
];

export default function ReportsPage(): JSX.Element {
  return (
    <AppShell requires="reports.view">
      <ReportsScreen />
    </AppShell>
  );
}

function ReportsScreen(): JSX.Element {
  const [tab, setTab] = useState<Tab>('close-out');
  // The night the close-out opens on, and the range every other tab reads.
  // Both default to the trading present: tonight, and the trading month it sits in.
  const [night, setNight] = useState(() => currentBusinessDay());
  const [range, setRange] = useState<TradingRange>(() => currentTradingMonth());
  const [groupBy, setGroupBy] = useState<ReportGroupBy>('day');

  const active = TABS.find((entry) => entry.key === tab) ?? TABS[0]!;

  return (
    <div className="mx-auto w-full max-w-[1180px] px-4 py-6 sm:px-6 sm:py-8">
      <nav className="mb-5 flex flex-wrap gap-1.5" aria-label="Reports">
        {TABS.map((entry) => {
          const selected = entry.key === tab;
          return (
            <button
              key={entry.key}
              type="button"
              onClick={() => setTab(entry.key)}
              aria-current={selected ? 'page' : undefined}
              className={[
                'flex min-h-[44px] items-center rounded-full border px-4 text-[13px] uppercase tracking-label transition-colors',
                selected
                  ? 'border-teal-700 bg-teal-700 text-white'
                  : 'border-line bg-white text-ink-muted hover:border-line-strong hover:text-ink',
              ].join(' ')}
            >
              {entry.label}
            </button>
          );
        })}
      </nav>

      {tab === 'close-out' ? (
        <DailyCloseOut day={night} onDayChange={setNight} />
      ) : (
        <div className="grid gap-5">
          <header>
            <p className="eyebrow mb-1.5">{active.hint}</p>
            <h1 className="font-serif text-[28px] leading-tight text-ink">{active.label}</h1>
          </header>

          <div className="rounded-xl border border-line bg-white px-4 py-4 sm:px-5">
            <RangePicker range={range} onChange={setRange} />
          </div>

          {tab === 'revenue' ? (
            <RevenueReport range={range} groupBy={groupBy} onGroupByChange={setGroupBy} />
          ) : null}
          {tab === 'therapists' ? <TherapistReport range={range} /> : null}
          {tab === 'tips' ? <TipsReport range={range} /> : null}
          {tab === 'channels' ? <AttributionReport range={range} /> : null}
        </div>
      )}
    </div>
  );
}
