'use client';

import { formatAed } from '@berelax/contracts';
import type { ReportGroupBy, RevenueReportView } from '@/lib/api-types';
import { useReport } from '@/lib/use-report';
import { Button } from '@/components/ui/button';
import type { TradingRange } from './range-picker';
import {
  Bar,
  Basis,
  Count,
  Figure,
  Legend,
  LegendLine,
  Panel,
  ReportFrame,
  Row,
  Table,
  Td,
  Th,
  Tiles,
} from './report-ui';

const GROUPINGS: Array<{ key: ReportGroupBy; label: string }> = [
  { key: 'day', label: 'By night' },
  { key: 'week', label: 'By week' },
  { key: 'month', label: 'By month' },
];

/**
 * Revenue over time — and, beside it and never inside it, the two tip lines.
 *
 * The teal bar is what the business earned. The gold and oat bars are money it
 * is holding for somebody else, and money that never reached it at all. They
 * are drawn on the same axis so the proportion is honest, in different colours
 * so the three are never read as one, and the legend under them carries the
 * API's own wording. §9.1.
 */
export function RevenueReport({
  range,
  groupBy,
  onGroupByChange,
}: {
  range: TradingRange;
  groupBy: ReportGroupBy;
  onGroupByChange: (groupBy: ReportGroupBy) => void;
}): JSX.Element {
  const state = useReport<RevenueReportView>(
    `/reports/revenue?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}&groupBy=${groupBy}`,
  );

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap gap-2">
        {GROUPINGS.map((grouping) => (
          <Button
            key={grouping.key}
            variant={grouping.key === groupBy ? 'primary' : 'secondary'}
            size="md"
            onClick={() => onGroupByChange(grouping.key)}
          >
            {grouping.label}
          </Button>
        ))}
      </div>

      <ReportFrame state={state}>{(report) => <RevenueBody report={report} />}</ReportFrame>
    </div>
  );
}

function RevenueBody({ report }: { report: RevenueReportView }): JSX.Element {
  const { totals, periods, legend } = report;

  // One axis for every bar on the panel, taken across all three series so the
  // proportion between them is drawn to scale rather than each to its own.
  const scale = Math.max(
    1,
    ...periods.map((period) =>
      Math.max(
        period.netRevenueFils,
        period.tipsCollectedByBusinessFils + period.tipsDirectCashFils,
      ),
    ),
  );

  return (
    <div className="grid gap-4">
      <Tiles>
        <Figure
          label="Revenue"
          fils={totals.netRevenueFils}
          tone="revenue"
          sub="Treatments, net of refunds and adjustments"
        />
        <Figure label="Collected at the desk" fils={totals.baseCollectedFils} />
        <Count label="Treatments completed" value={totals.completedVisits} />
        <Count
          label="No-shows and cancellations"
          value={totals.noShows + totals.cancellations}
          sub={`${totals.noShows} no-show, ${totals.cancellations} cancelled`}
        />
      </Tiles>

      <Tiles>
        <Figure
          label="Tips on the bill"
          fils={totals.tipsCollectedByBusinessFils}
          tone="payable"
          sub="Owed out — not earnings"
        />
        <Figure
          label="Tips in cash"
          fils={totals.tipsDirectCashFils}
          tone="outside"
          sub="Never entered the business"
        />
        <Figure label="Refunds" fils={totals.baseRefundedFils} tone={totals.baseRefundedFils < 0 ? 'alert' : 'ink'} />
        <Figure label="Adjustments" fils={totals.adjustmentsFils} />
      </Tiles>

      <Panel
        title="Over time"
        hint={`${periods.length} period${periods.length === 1 ? '' : 's'}, cut on trading nights`}
      >
        {periods.length === 0 ? (
          <p className="text-[14px] text-ink-muted">No trading nights in this period.</p>
        ) : (
          <div className="grid gap-2.5">
            {periods.map((period) => (
              <div
                key={period.periodStart}
                className="grid grid-cols-[minmax(84px,120px)_minmax(0,1fr)_minmax(96px,120px)] items-center gap-3"
              >
                <span className="truncate text-[12.5px] text-ink-muted numeric" title={period.label}>
                  {period.label}
                </span>
                <div className="grid gap-[3px]">
                  <Bar
                    value={period.netRevenueFils}
                    scale={scale}
                    series="revenue"
                    height={13}
                    title={`Revenue ${formatAed(period.netRevenueFils)}`}
                  />
                  <div className="flex gap-[3px]">
                    <Bar
                      value={period.tipsCollectedByBusinessFils}
                      scale={scale}
                      series="payable"
                      height={5}
                      title={`Tips on the bill ${formatAed(period.tipsCollectedByBusinessFils)}`}
                    />
                    <Bar
                      value={period.tipsDirectCashFils}
                      scale={scale}
                      series="outside"
                      height={5}
                      title={`Tips in cash ${formatAed(period.tipsDirectCashFils)}`}
                    />
                  </div>
                </div>
                <span className="text-right text-[13.5px] text-ink numeric">
                  {formatAed(period.netRevenueFils)}
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="mt-5 border-t border-line pt-4">
          <Legend>
            <LegendLine series="revenue" name="Revenue" meaning={legend.revenue} />
            <LegendLine
              series="payable"
              name="Tips on the bill"
              meaning={legend.tipsCollectedByBusiness}
            />
            <LegendLine series="outside" name="Tips in cash" meaning={legend.tipsDirectCash} />
          </Legend>
        </div>
      </Panel>

      <Panel title="The numbers" hint="Every period, in full">
        <Table
          head={
            <>
              <Th>Period</Th>
              <Th numeric>Visits</Th>
              <Th numeric>Collected</Th>
              <Th numeric>Refunds</Th>
              <Th numeric>Adjustments</Th>
              <Th numeric>Revenue</Th>
              <Th numeric>Tips on bill</Th>
              <Th numeric>Tips in cash</Th>
            </>
          }
        >
          {periods.map((period) => (
            <Row key={period.periodStart}>
              <Td muted>{period.label}</Td>
              <Td numeric muted>{period.completedVisits}</Td>
              <Td numeric>{formatAed(period.baseCollectedFils)}</Td>
              <Td numeric muted>{formatAed(period.baseRefundedFils)}</Td>
              <Td numeric muted>{formatAed(period.adjustmentsFils)}</Td>
              <Td numeric>{formatAed(period.netRevenueFils)}</Td>
              <Td numeric muted>{formatAed(period.tipsCollectedByBusinessFils)}</Td>
              <Td numeric muted>{formatAed(period.tipsDirectCashFils)}</Td>
            </Row>
          ))}
          <Row total>
            <Td>Total</Td>
            <Td numeric>{totals.completedVisits}</Td>
            <Td numeric>{formatAed(totals.baseCollectedFils)}</Td>
            <Td numeric>{formatAed(totals.baseRefundedFils)}</Td>
            <Td numeric>{formatAed(totals.adjustmentsFils)}</Td>
            <Td numeric>{formatAed(totals.netRevenueFils)}</Td>
            <Td numeric>{formatAed(totals.tipsCollectedByBusinessFils)}</Td>
            <Td numeric>{formatAed(totals.tipsDirectCashFils)}</Td>
          </Row>
        </Table>
      </Panel>

      <Basis>
        The revenue column is treatments only. Neither tip column is added into it and neither
        should be added into it downstream: one is money BE RELAX is holding on a therapist&rsquo;s
        behalf, the other never passed through the business at all.
      </Basis>
    </div>
  );
}
