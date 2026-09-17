'use client';

import { formatAed } from '@berelax/contracts';
import type {
  AttributionChannelView,
  AttributionReportView,
  ChannelRole,
} from '@/lib/api-types';
import { useReport } from '@/lib/use-report';
import type { TradingRange } from './range-picker';
import {
  Bar,
  Basis,
  Count,
  EmptyRow,
  Figure,
  Panel,
  ReportFrame,
  Row,
  Table,
  Td,
  Th,
  Tiles,
} from './report-ui';

const ROLE_COPY: Record<ChannelRole, { label: string; pill: string; meaning: string }> = {
  DISCOVERS: {
    label: 'Finds guests',
    pill: 'bg-teal-100 text-teal-700 border-teal-300',
    meaning: 'Worth more than a last-touch report shows. Cutting it costs bookings elsewhere.',
  },
  CLOSES: {
    label: 'Closes guests',
    pill: 'bg-gold-pale text-gold-deep border-gold-light',
    meaning: 'Credited with sales another channel found. It converts; it does not discover.',
  },
  BALANCED: {
    label: 'Both',
    pill: 'bg-oat text-ink-muted border-line-strong',
    meaning: 'Both models agree about this channel.',
  },
};

/**
 * Channel ROI, first touch and last touch.
 *
 * The gap goes first, because the gap is the finding. A channel that finds
 * guests somebody else closes looks worthless in a last-touch table and gets
 * cut; the same channel looks like the whole business in a first-touch one.
 * Showing one model alone is how a spa turns off the advertising that was
 * working. §10.6.
 */
export function AttributionReport({ range }: { range: TradingRange }): JSX.Element {
  const state = useReport<AttributionReportView>(
    `/reports/attribution?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`,
  );

  return <ReportFrame state={state}>{(report) => <AttributionBody report={report} />}</ReportFrame>;
}

function AttributionBody({ report }: { report: AttributionReportView }): JSX.Element {
  const { totals, gap, firstTouch, lastTouch } = report;
  const scale = Math.max(
    1,
    ...gap.map((row) => Math.max(row.firstTouchRevenueFils, row.lastTouchRevenueFils)),
  );

  return (
    <div className="grid gap-4">
      <Tiles>
        <Count label="Visitors" value={totals.visitors} sub="Attribution captured in this period" />
        <Count
          label="Website enquiries"
          value={totals.enquiries}
          sub={totals.enquiries === 0 ? 'None — these guests booked at the desk' : undefined}
        />
        <Count
          label="Visits completed"
          value={totals.completedVisits}
          sub={`${totals.bookings} bookings taken`}
        />
        <Figure label="Revenue" fils={totals.revenueFils} tone="revenue" sub="Treatments only" />
      </Tiles>

      <Panel
        title="The gap between the two models"
        hint="The most useful number here — ordered by how far apart they are"
      >
        {gap.length === 0 ? (
          <p className="text-[14px] text-ink-muted">
            No attributed visitors in this period, so there is nothing to compare.
          </p>
        ) : (
          <div className="grid gap-4">
            {gap.map((row) => (
              <div key={channelKey(row)} className="grid gap-1.5">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-[14px] font-medium text-ink">
                    {row.source} <span className="text-ink-muted">/ {row.medium}</span>
                  </span>
                  {row.campaign ? (
                    <span className="text-[12.5px] text-ink-muted">{row.campaign}</span>
                  ) : null}
                  <span
                    className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-label ${ROLE_COPY[row.role].pill}`}
                  >
                    {ROLE_COPY[row.role].label}
                  </span>
                  <span className="ml-auto text-[13px] text-ink-muted numeric">
                    {row.differenceFils === 0
                      ? 'no difference'
                      : `${row.differenceFils > 0 ? '+' : '−'}${formatAed(Math.abs(row.differenceFils))} on first touch`}
                  </span>
                </div>

                <div className="grid grid-cols-[minmax(74px,92px)_minmax(0,1fr)_minmax(96px,116px)] items-center gap-3">
                  <span className="text-[12px] uppercase tracking-label text-ink-muted">Found</span>
                  <Bar value={row.firstTouchRevenueFils} scale={scale} series="neutral" />
                  <span className="text-right text-[13px] text-ink numeric">
                    {formatAed(row.firstTouchRevenueFils)}
                  </span>
                </div>
                <div className="grid grid-cols-[minmax(74px,92px)_minmax(0,1fr)_minmax(96px,116px)] items-center gap-3">
                  <span className="text-[12px] uppercase tracking-label text-ink-muted">Closed</span>
                  <Bar value={row.lastTouchRevenueFils} scale={scale} series="revenue" />
                  <span className="text-right text-[13px] text-ink numeric">
                    {formatAed(row.lastTouchRevenueFils)}
                  </span>
                </div>
                <p className="text-[12.5px] leading-snug text-ink-muted">
                  {ROLE_COPY[row.role].meaning} {row.firstTouchCompletedVisits} visit
                  {row.firstTouchCompletedVisits === 1 ? '' : 's'} started here,{' '}
                  {row.lastTouchCompletedVisits} finished here.
                </p>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <div className="grid gap-4 xl:grid-cols-2">
        <ChannelTable
          title="First touch"
          hint="Credits the channel that found the guest"
          rows={firstTouch}
        />
        <ChannelTable
          title="Last touch"
          hint="Credits the channel that closed the booking"
          rows={lastTouch}
        />
      </div>

      <Basis>{report.basis}</Basis>
    </div>
  );
}

function ChannelTable({
  title,
  hint,
  rows,
}: {
  title: string;
  hint: string;
  rows: AttributionChannelView[];
}): JSX.Element {
  return (
    <Panel title={title} hint={hint}>
      <Table
        head={
          <>
            <Th>Channel</Th>
            <Th numeric>Visitors</Th>
            <Th numeric>Enquiries</Th>
            <Th numeric>Visits</Th>
            <Th numeric>Revenue</Th>
            <Th numeric>Conversion</Th>
          </>
        }
      >
        {rows.length === 0 ? (
          <EmptyRow span={6}>Nothing attributed in this period.</EmptyRow>
        ) : (
          rows.map((row) => (
            <Row key={channelKey(row)}>
              <Td>
                {row.source} <span className="text-ink-muted">/ {row.medium}</span>
                {row.campaign ? (
                  <span className="block text-[12px] text-ink-muted">{row.campaign}</span>
                ) : null}
              </Td>
              <Td numeric muted>{row.visitors}</Td>
              <Td numeric muted>{row.enquiries}</Td>
              <Td numeric>
                {row.completedVisits}
                <span className="ml-1 text-[12px] text-ink-muted">/ {row.bookings}</span>
              </Td>
              <Td numeric>{formatAed(row.revenueFils)}</Td>
              {/* Null, not 0% — nobody enquired, so nothing failed to convert. */}
              <Td numeric muted>
                {row.conversionPct === null ? (
                  <span title="No website enquiries from this channel — these guests were booked at the desk">
                    —
                  </span>
                ) : (
                  `${row.conversionPct.toFixed(1)}%`
                )}
              </Td>
            </Row>
          ))
        )}
      </Table>
    </Panel>
  );
}

function channelKey(row: { source: string; medium: string; campaign: string | null }): string {
  return `${row.source}|${row.medium}|${row.campaign ?? ''}`;
}
