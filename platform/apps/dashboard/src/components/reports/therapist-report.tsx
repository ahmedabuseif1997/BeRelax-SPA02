'use client';

import { formatAed } from '@berelax/contracts';
import type { UtilisationReportView } from '@/lib/api-types';
import { useReport } from '@/lib/use-report';
import type { TradingRange } from './range-picker';
import {
  Basis,
  Count,
  EmptyRow,
  Figure,
  Meter,
  Panel,
  ReportFrame,
  Row,
  Table,
  Td,
  Th,
  Tiles,
} from './report-ui';

/**
 * Per therapist, over a range of trading nights.
 *
 * Utilisation is booked minutes over ROSTERED minutes, and the roster column is
 * shown next to it so the divisor is never a mystery. A therapist who worked a
 * four-hour shift is not idle for the other eleven hours of the night, and the
 * first time a report implies they were, it stops being read.
 */
export function TherapistReport({ range }: { range: TradingRange }): JSX.Element {
  const state = useReport<UtilisationReportView>(
    `/reports/therapist-utilisation?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`,
  );

  return <ReportFrame state={state}>{(report) => <TherapistBody report={report} />}</ReportFrame>;
}

function TherapistBody({ report }: { report: UtilisationReportView }): JSX.Element {
  const { therapists, totals } = report;

  return (
    <div className="grid gap-4">
      <Tiles>
        <Count label="Therapists who worked" value={therapists.length} />
        <Count label="Treatments delivered" value={totals.sessions} />
        <div className="rounded-xl border border-line bg-white px-4 py-4">
          <p className="text-[11.5px] uppercase tracking-label text-ink-muted">Floor utilisation</p>
          <p className="mt-1 font-serif text-[27px] leading-none text-teal-700 numeric">
            {totals.utilisationPct === null ? '—' : `${totals.utilisationPct.toFixed(1)}%`}
          </p>
          <p className="mt-1.5 text-[12.5px] leading-snug text-ink-muted">
            {hours(totals.minutesBooked)} booked of {hours(totals.minutesRostered)} rostered
          </p>
        </div>
        <Figure
          label="Revenue generated"
          fils={totals.revenueGeneratedFils}
          tone="revenue"
          sub="Treatments, net of refunds"
        />
      </Tiles>

      <Panel title="By therapist" hint="Sorted by minutes actually delivered">
        <Table
          head={
            <>
              <Th>Therapist</Th>
              <Th numeric>Sessions</Th>
              <Th numeric>Booked</Th>
              <Th numeric>Rostered</Th>
              <Th width="20%">Utilisation</Th>
              <Th numeric>Revenue</Th>
              <Th numeric>Tips in cash</Th>
              <Th numeric>Tips on bill</Th>
            </>
          }
        >
          {therapists.length === 0 ? (
            <EmptyRow span={8}>
              Nobody was rostered or booked on these nights.
            </EmptyRow>
          ) : (
            therapists.map((therapist) => (
              <Row key={therapist.employeeId}>
                <Td>
                  {therapist.displayName}
                  {therapist.noShows > 0 ? (
                    <span className="ml-2 text-[12px] text-ink-muted">
                      {therapist.noShows} no-show{therapist.noShows === 1 ? '' : 's'} ·{' '}
                      {hours(therapist.minutesLostToNoShows)} held
                    </span>
                  ) : null}
                </Td>
                <Td numeric muted>{therapist.sessions}</Td>
                <Td numeric>{hours(therapist.minutesBooked)}</Td>
                <Td numeric muted>{hours(therapist.minutesRostered)}</Td>
                <Td>
                  <Meter pct={therapist.utilisationPct} />
                </Td>
                <Td numeric>{formatAed(therapist.revenueGeneratedFils)}</Td>
                <Td numeric muted>{formatAed(therapist.tips.directCash.totalFils)}</Td>
                <Td numeric muted>{formatAed(therapist.tips.collectedByBusiness.totalFils)}</Td>
              </Row>
            ))
          )}
          {therapists.length > 0 ? (
            <Row total>
              <Td>Floor</Td>
              <Td numeric>{totals.sessions}</Td>
              <Td numeric>{hours(totals.minutesBooked)}</Td>
              <Td numeric>{hours(totals.minutesRostered)}</Td>
              <Td>
                <Meter pct={totals.utilisationPct} />
              </Td>
              <Td numeric>{formatAed(totals.revenueGeneratedFils)}</Td>
              <Td numeric>{formatAed(totals.tipsDirectCashFils)}</Td>
              <Td numeric>{formatAed(totals.tipsCollectedByBusinessFils)}</Td>
            </Row>
          ) : null}
        </Table>
      </Panel>

      <Basis>{report.basis}</Basis>
    </div>
  );
}

/** Minutes are what the database holds; hours are what a rota is argued in. */
function hours(minutes: number): string {
  if (minutes === 0) return '0 h';
  if (minutes < 60) return `${minutes} min`;
  const whole = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${whole} h` : `${whole} h ${rest} m`;
}
