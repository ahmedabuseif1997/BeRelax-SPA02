'use client';

import { useCallback, useMemo, useState } from 'react';
import { AppShell } from '@/components/app-shell';
import { NightPicker } from '@/components/reports/range-picker';
import { Panel, ReportFrame, Row, Table, Td, Th } from '@/components/reports/report-ui';
import { useAuth } from '@/lib/auth-context';
import { businessDayLabel, currentBusinessDay, shiftBusinessDay } from '@/lib/grid-time';
import { useReport } from '@/lib/use-report';
import { CloseOutSheet } from './close-out-sheet';
import { PaperForm } from './paper-form';
import type {
  CloseOutSheetView,
  ReconciliationHistoryView,
  ReconciliationRecordView,
  ReconciliationResultView,
  StreakView,
  SubmitReconciliationBody,
} from './types';
import { FindingList, PilotLadder, StreakBanner, VerdictPanel, variance } from './verdict';

/**
 * Phase 7 — the parallel pilot. §14.
 *
 * MANAGER+, route-guarded rather than link-hidden alone: a receptionist who
 * types /reconciliation is sent back to the grid, and the API refuses all four
 * endpoints again with 403 INSUFFICIENT_ROLE. §6.4 draws that line on purpose —
 * reception counts the drawer, somebody else signs the night off.
 *
 * The page answers one question above everything else, and answers it in the
 * first 200 pixels: can we switch over yet? Underneath it, the ladder of the
 * last fortnight makes the SHAPE of the answer visible — five teal cells in a
 * row is the goal, one terracotta cell is a night to investigate, and an oat
 * cell is a night nobody reconciled, which is not a pass.
 *
 * Every figure is integer fils on the wire and passes through `formatAed`
 * exactly once, where it is drawn (§3.1). Every period is a TRADING night, so
 * the 01:30 booking counts against the night before (§3.3). And if the API
 * cannot be reached, the last real figures stay on screen with their age on
 * them rather than collapsing to zeros (§12.2) — "the drawer should be empty"
 * is a sentence somebody acts on.
 */

/** The pilot is two weeks (§14), so the ladder shows a fortnight. */
const LADDER_NIGHTS = 14;

export default function ReconciliationPage(): JSX.Element {
  return (
    <AppShell requires="reports.view">
      <ReconciliationScreen />
    </AppShell>
  );
}

function ReconciliationScreen(): JSX.Element {
  const { client } = useAuth();

  // Last night, not tonight: the night a manager is closing out is the one that
  // has just finished. Tonight's figures are still moving.
  const [night, setNight] = useState(() => shiftBusinessDay(currentBusinessDay(), -1));
  const [result, setResult] = useState<ReconciliationResultView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const [reloads, setReloads] = useState(0);

  const sheet = useReport<CloseOutSheetView>(
    `/reconciliation/${encodeURIComponent(night)}/sheet?r=${reloads}`,
  );
  const streak = useReport<StreakView>(`/reconciliation/streak?r=${reloads}`);
  // The window covers the fortnight the ladder draws AND whatever night is open,
  // so browsing back to an older night still shows what was recorded for it
  // rather than an empty form over a night that was reconciled weeks ago.
  const ladderFrom = shiftBusinessDay(currentBusinessDay(), -(LADDER_NIGHTS - 1));
  const history = useReport<ReconciliationHistoryView>(
    `/reconciliation?from=${night < ladderFrom ? night : ladderFrom}` +
      `&to=${currentBusinessDay()}&r=${reloads}`,
  );

  const submit = useCallback(
    async (body: SubmitReconciliationBody): Promise<void> => {
      setPending(true);
      setError(null);
      try {
        const answer = await client.request<ReconciliationResultView>(
          `/reconciliation/${encodeURIComponent(night)}`,
          { method: 'POST', body },
        );
        setResult(answer);
        // The streak, the ladder and the sheet are all downstream of this
        // submission, so they are re-read rather than patched by hand.
        setReloads((n) => n + 1);
      } catch (failure) {
        setError(failure);
      } finally {
        setPending(false);
      }
    },
    [client, night],
  );

  const selectNight = useCallback((day: string): void => {
    setNight(day);
    setResult(null);
    setError(null);
  }, []);

  const ladder = useLadder(history.data, streak.data);
  const alreadyDone = useMemo(
    () => latestForNight(history.data, night),
    [history.data, night],
  );
  // What is on screen for this night: the submission just made, or the one
  // already on file. Never both, and never a stale one from another night.
  const showing = result?.businessDay === night ? result : alreadyDone;

  return (
    <div className="mx-auto w-full max-w-[1180px] px-4 py-6 sm:px-6 sm:py-8">
      <header className="mb-5">
        <p className="eyebrow mb-1.5">Phase 7 · running beside the paper process</p>
        <h1 className="font-serif text-[28px] leading-tight text-ink">Nightly reconciliation</h1>
      </header>

      <div className="grid gap-4">
        <ReportFrame state={streak}>{(view) => <StreakBanner streak={view} />}</ReportFrame>

        <Panel title="The last fortnight" hint="One cell per trading night — tap one to open it">
          <ReportFrame state={history}>
            {() => (
              <>
                <PilotLadder nights={ladder} selected={night} onSelect={selectNight} />
                <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-[12.5px] text-ink-muted">
                  <LegendKey className="bg-teal-700" label="matched" />
                  <LegendKey className="bg-teal-100 border border-teal-700" label="matched, with a note" />
                  <LegendKey className="bg-alert" label="did not match" />
                  <LegendKey className="bg-oat-light border border-line" label="not reconciled" />
                </ul>
              </>
            )}
          </ReportFrame>
        </Panel>

        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow mb-1.5">Closing out</p>
            <h2 className="font-serif text-[23px] leading-tight text-ink">
              {businessDayLabel(night)}
            </h2>
          </div>
          <NightPicker day={night} onChange={selectNight} />
        </div>

        {showing ? (
          <VerdictPanel record={showing}>
            <FindingList failing={result?.businessDay === night ? result.failing : outLines(showing)} />
            <p className="mt-4 text-[13px] leading-relaxed text-ink-muted">
              Reconciling this night again records a new submission beside this one — nothing is
              overwritten. Do that once the difference has been found, not to make it go away.
            </p>
          </VerdictPanel>
        ) : null}

        <div className="grid gap-4 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)] lg:items-start">
          <ReportFrame state={sheet}>
            {(view) => (
              <PaperForm
                businessDay={night}
                toCheck={view.toCheck}
                onSubmit={(body) => void submit(body)}
                pending={pending}
                error={error}
                onDismissError={() => setError(null)}
              />
            )}
          </ReportFrame>

          <ReportFrame state={sheet}>{(view) => <CloseOutSheet sheet={view} />}</ReportFrame>
        </div>

        <Panel
          title="Every submission"
          hint="Corrections included — the attempts are the record"
        >
          <ReportFrame state={history}>{(view) => <HistoryTable history={view} />}</ReportFrame>
        </Panel>
      </div>
    </div>
  );
}

/* ───────────────────────── the ladder ───────────────────────── */

/**
 * The last fortnight of trading nights, each carrying the verdict that counts
 * for it — the MOST RECENT submission, since a corrected night is the night as
 * it finally stood.
 *
 * A night with no submission is `null`, drawn in its own colour. That is the
 * whole reason this is built from a date walk rather than from the rows: a list
 * of submissions cannot show the night that is missing, and the missing night
 * is exactly what breaks a run of five.
 */
function useLadder(
  history: ReconciliationHistoryView | null,
  streak: StreakView | null,
): Array<{ businessDay: string; verdict: string | null }> {
  return useMemo(() => {
    const today = streak?.asOf ?? currentBusinessDay();
    const effective = new Map<string, string>();
    for (const entry of history?.entries ?? []) {
      if (entry.isLatestForNight) effective.set(entry.businessDay, entry.verdict);
    }

    return Array.from({ length: LADDER_NIGHTS }, (_, index) => {
      const day = shiftBusinessDay(today, -(LADDER_NIGHTS - 1 - index));
      return { businessDay: day, verdict: effective.get(day) ?? null };
    });
  }, [history, streak]);
}

function latestForNight(
  history: ReconciliationHistoryView | null,
  night: string,
): ReconciliationRecordView | null {
  return (
    history?.entries.find((entry) => entry.businessDay === night && entry.isLatestForNight) ?? null
  );
}

function outLines(record: ReconciliationRecordView) {
  return record.lines.filter((line) => line.compared && !line.withinTolerance);
}

function LegendKey({ className, label }: { className: string; label: string }): JSX.Element {
  return (
    <li className="flex items-center gap-2">
      <span className={`h-3 w-3 rounded-[4px] ${className}`} />
      {label}
    </li>
  );
}

/* ───────────────────────── the history ───────────────────────── */

const VERDICT_LABEL: Record<string, string> = {
  MATCHED: 'Matched',
  MATCHED_WITH_NOTE: 'Matched · noted',
  MISMATCHED: 'Did not match',
};

function HistoryTable({ history }: { history: ReconciliationHistoryView }): JSX.Element {
  return (
    <>
      <Table
        head={
          <>
            <Th width="22%">Trading night</Th>
            <Th>Verdict</Th>
            <Th numeric>Cash</Th>
            <Th numeric>Card</Th>
            <Th numeric>Sessions</Th>
            <Th>Submitted</Th>
          </>
        }
      >
        {history.entries.length === 0 ? (
          <Row>
            <Td muted>No night in this window has been reconciled yet.</Td>
            <Td muted>—</Td>
            <Td numeric muted>—</Td>
            <Td numeric muted>—</Td>
            <Td numeric muted>—</Td>
            <Td muted>—</Td>
          </Row>
        ) : (
          history.entries.map((entry) => (
            <Row key={entry.id}>
              <Td muted={!entry.isLatestForNight}>
                {businessDayLabel(entry.businessDay, true)}
                {entry.isLatestForNight ? null : (
                  <span className="ml-2 text-[11.5px] uppercase tracking-label text-ink-muted">
                    superseded
                  </span>
                )}
              </Td>
              <Td>
                <span className={entry.matched ? 'text-teal-700' : 'font-medium text-alert-deep'}>
                  {VERDICT_LABEL[entry.verdict] ?? entry.verdict}
                </span>
              </Td>
              <Td numeric>{variance(entry.variance.cashFils, 'FILS')}</Td>
              <Td numeric>{variance(entry.variance.cardFils, 'FILS')}</Td>
              <Td numeric>{variance(entry.variance.bookings, 'COUNT')}</Td>
              <Td muted>
                {new Date(entry.submittedAt).toLocaleString('en-AE', {
                  timeZone: 'Asia/Dubai',
                  dateStyle: 'short',
                  timeStyle: 'short',
                })}
              </Td>
            </Row>
          ))
        )}
      </Table>
      <p className="mt-4 text-[12.5px] leading-relaxed text-ink-muted">
        {history.submissions} submission{history.submissions === 1 ? '' : 's'} across{' '}
        {history.nightsReconciled} night{history.nightsReconciled === 1 ? '' : 's'}. The columns are
        variances — paper minus system — so a run of zeros is what a finished pilot looks like.
        Superseded rows are kept: a night that took three attempts to match is worth knowing about.
      </p>
    </>
  );
}
