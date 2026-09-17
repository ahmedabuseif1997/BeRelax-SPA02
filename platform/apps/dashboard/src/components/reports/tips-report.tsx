'use client';

import { formatAed } from '@berelax/contracts';
import type { TipsReportView } from '@/lib/api-types';
import { businessDayLabel } from '@/lib/grid-time';
import { useReport } from '@/lib/use-report';
import type { TradingRange } from './range-picker';
import {
  Bar,
  Basis,
  EmptyRow,
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

/**
 * Tips, in two halves that are never added together.
 *
 * The left of this page is what a therapist EARNED; the right is what BE RELAX
 * OWES. They come from two different tables and they answer two different
 * questions — a cash tip is earnings and is not a debt, because the business
 * never held it. Summing the two columns is how a spa pays a tip twice, so the
 * layout keeps them apart and says so. §9.1, §9.2.
 */
export function TipsReport({ range }: { range: TradingRange }): JSX.Element {
  const state = useReport<TipsReportView>(
    `/reports/tips?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`,
  );

  return <ReportFrame state={state}>{(report) => <TipsBody report={report} />}</ReportFrame>;
}

function TipsBody({ report }: { report: TipsReportView }): JSX.Element {
  const { byMode, byTherapist, byDay, payable } = report;
  const dayScale = Math.max(1, ...byDay.map((day) => day.totalFils));

  return (
    <div className="grid gap-4">
      <Tiles>
        <Figure
          label="Tips in cash"
          fils={byMode.directCash.totalFils}
          tone="outside"
          sub={`${byMode.directCash.tipCount} tips · already with the therapist`}
        />
        <Figure
          label="Tips on the bill"
          fils={byMode.collectedByBusiness.totalFils}
          tone="payable"
          sub={`${byMode.collectedByBusiness.tipCount} tips · held by BE RELAX`}
        />
        <Figure
          label="Earned in this period"
          fils={byMode.totalFils}
          sub="Both modes, whoever is holding it"
        />
        <Figure
          label="Owed right now"
          fils={payable.totalOutstandingFils}
          tone="payable"
          sub={`${formatAed(payable.totalUnbatchedFils)} not yet in a payout batch`}
        />
      </Tiles>

      <Panel title="By therapist" hint="Earned in this period, owed over all time">
        <Table
          head={
            <>
              <Th>Therapist</Th>
              <Th numeric>Tips in cash</Th>
              <Th numeric>Tips on bill</Th>
              <Th numeric>Earned</Th>
              <Th numeric>Owed now</Th>
              <Th numeric>Not yet batched</Th>
            </>
          }
        >
          {byTherapist.length === 0 ? (
            <EmptyRow span={6}>No tips and no open balances in this period.</EmptyRow>
          ) : (
            byTherapist.map((therapist) => (
              <Row key={therapist.employeeId}>
                <Td>{therapist.displayName}</Td>
                <Td numeric muted>
                  {formatAed(therapist.directCash.totalFils)}
                  <span className="ml-1.5 text-[12px] text-ink-muted">
                    ×{therapist.directCash.tipCount}
                  </span>
                </Td>
                <Td numeric muted>
                  {formatAed(therapist.collectedByBusiness.totalFils)}
                  <span className="ml-1.5 text-[12px] text-ink-muted">
                    ×{therapist.collectedByBusiness.tipCount}
                  </span>
                </Td>
                <Td numeric>{formatAed(therapist.totalEarnedFils)}</Td>
                <Td numeric>
                  <span className="text-gold-deep">
                    {formatAed(therapist.outstandingPayableFils)}
                  </span>
                </Td>
                <Td numeric muted>{formatAed(therapist.unbatchedPayableFils)}</Td>
              </Row>
            ))
          )}
          {byTherapist.length > 0 ? (
            <Row total>
              <Td>Total</Td>
              <Td numeric>{formatAed(byMode.directCash.totalFils)}</Td>
              <Td numeric>{formatAed(byMode.collectedByBusiness.totalFils)}</Td>
              <Td numeric>{formatAed(byMode.totalFils)}</Td>
              <Td numeric>{formatAed(payable.totalOutstandingFils)}</Td>
              <Td numeric>{formatAed(payable.totalUnbatchedFils)}</Td>
            </Row>
          ) : null}
        </Table>
        <p className="mt-3 text-[12.5px] leading-snug text-ink-muted">
          <strong className="font-medium text-ink">Earned</strong> is this period.{' '}
          <strong className="font-medium text-ink">Owed now</strong> is the whole payout ledger, all
          time — it carries commission and every payout already made, so it is not meant to match
          the column beside it.
        </p>
      </Panel>

      <Panel title="By night" hint="Filed to the trading night the tip was given on">
        {byDay.length === 0 ? (
          <p className="text-[14px] text-ink-muted">No tips were recorded on these nights.</p>
        ) : (
          <div className="grid gap-2.5">
            {byDay.map((day) => (
              <div
                key={day.businessDay}
                className="grid grid-cols-[minmax(110px,160px)_minmax(0,1fr)_minmax(96px,120px)] items-center gap-3"
              >
                <span className="truncate text-[12.5px] text-ink-muted">
                  {businessDayLabel(day.businessDay, true)}
                </span>
                <div className="flex gap-[3px]">
                  <Bar
                    value={day.collectedByBusiness.totalFils}
                    scale={dayScale}
                    series="payable"
                    title={`On the bill ${formatAed(day.collectedByBusiness.totalFils)}`}
                  />
                  <Bar
                    value={day.directCash.totalFils}
                    scale={dayScale}
                    series="outside"
                    title={`In cash ${formatAed(day.directCash.totalFils)}`}
                  />
                </div>
                <span className="text-right text-[13.5px] text-ink numeric">
                  {formatAed(day.totalFils)}
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="mt-5 border-t border-line pt-4">
          <Legend>
            <LegendLine
              series="payable"
              name="Tips on the bill"
              meaning={byMode.labels.collectedByBusiness}
            />
            <LegendLine series="outside" name="Tips in cash" meaning={byMode.labels.directCash} />
          </Legend>
        </div>
      </Panel>

      <Basis>{payable.basis}</Basis>
    </div>
  );
}
