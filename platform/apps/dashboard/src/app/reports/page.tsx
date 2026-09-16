'use client';

import { useEffect, useState } from 'react';
import { formatAed } from '@berelax/contracts';
import { AppShell } from '@/components/app-shell';
import { Button, Spinner } from '@/components/ui/button';
import { ErrorNotice } from '@/components/ui/error-notice';
import { useAuth } from '@/lib/auth-context';
import {
  businessDayLabel,
  currentBusinessDay,
  shiftBusinessDay,
} from '@/lib/grid-time';

/**
 * MANAGER+ only, and route-guarded rather than link-hidden alone: a receptionist
 * who types /reports is sent back to the grid. §6.4 draws this line on purpose —
 * the person handling cash all evening is not the person auditing it.
 *
 * `GET /reports/daily` is specified in §7.4 but the controller does not exist in
 * apps/api yet, so this page reads whatever it is given and says plainly when
 * there is nothing to read.
 */
export default function ReportsPage(): JSX.Element {
  return (
    <AppShell requires="reports.view">
      <DailyReport />
    </AppShell>
  );
}

interface DailyReportResponse {
  businessDay?: string;
  grossRevenueFils?: number;
  baseCollectedFils?: number;
  tipsCollectedFils?: number;
  tipsDirectCashFils?: number;
  reservations?: number;
  completed?: number;
  noShows?: number;
  cancelled?: number;
}

function DailyReport(): JSX.Element {
  const { client } = useAuth();
  const [day, setDay] = useState(() => currentBusinessDay());
  const [report, setReport] = useState<DailyReportResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const data = await client.request<DailyReportResponse>(
          `/reports/daily?businessDay=${encodeURIComponent(day)}`,
        );
        if (!cancelled) setReport(data);
      } catch (reportError) {
        if (!cancelled) {
          setReport(null);
          setError(reportError);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, day, attempt]);

  return (
    <div className="mx-auto w-full max-w-[860px] px-5 py-8 sm:px-6">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow mb-2">Daily close-out</p>
          <h1 className="font-serif text-[30px] leading-tight text-ink">
            {businessDayLabel(day)}
          </h1>
          <p className="mt-1 text-[13.5px] text-ink-muted">
            Trading day 11:00–02:00 — a 01:30 booking counts here, not on the next day.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setDay(shiftBusinessDay(day, -1))}>
            Previous
          </Button>
          <Button variant="secondary" onClick={() => setDay(shiftBusinessDay(day, 1))}>
            Next
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-3 text-ink-muted">
          <Spinner />
          <span>Reading the day…</span>
        </div>
      ) : error ? (
        <div className="grid gap-4">
          <ErrorNotice error={error} onRetry={() => setAttempt((n) => n + 1)} />
          <p className="text-[14px] leading-snug text-ink-muted">
            <span className="numeric">GET /reports/daily</span> is in the API surface (§7.4) but is
            not implemented in this build of the API. The grid, check-in and checkout do not depend
            on it.
          </p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <Figure label="Collected at the desk" fils={report?.baseCollectedFils} />
          <Figure label="Tips added to bills" fils={report?.tipsCollectedFils} />
          <Figure label="Tips paid in cash to therapists" fils={report?.tipsDirectCashFils} />
          <Figure label="Gross revenue" fils={report?.grossRevenueFils} />
          <Count label="Treatments completed" value={report?.completed} />
          <Count label="No-shows" value={report?.noShows} />
        </div>
      )}
    </div>
  );
}

function Figure({ label, fils }: { label: string; fils: number | undefined }): JSX.Element {
  return (
    <div className="rounded-xl border border-line bg-white px-4 py-4">
      <p className="text-[12px] uppercase tracking-label text-ink-muted">{label}</p>
      <p className="mt-1 font-serif text-[30px] leading-none text-ink numeric">
        {fils === undefined ? '—' : formatAed(fils)}
      </p>
    </div>
  );
}

function Count({ label, value }: { label: string; value: number | undefined }): JSX.Element {
  return (
    <div className="rounded-xl border border-line bg-white px-4 py-4">
      <p className="text-[12px] uppercase tracking-label text-ink-muted">{label}</p>
      <p className="mt-1 font-serif text-[30px] leading-none text-ink numeric">{value ?? '—'}</p>
    </div>
  );
}
