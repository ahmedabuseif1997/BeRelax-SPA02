'use client';

import { formatAed } from '@berelax/contracts';
import type { DailyReportView } from '@/lib/api-types';
import { businessDayLabel, businessDayRelation } from '@/lib/grid-time';
import { useReport } from '@/lib/use-report';
import {
  Bar,
  Basis,
  Count,
  Figure,
  Panel,
  ReportFrame,
  Row,
  Table,
  Td,
  Th,
  Tiles,
} from './report-ui';
import { NightPicker } from './range-picker';

/**
 * The close-out sheet: one trading night, and the landing view of this page.
 *
 * The figure the whole screen is arranged around is the expected cash in the
 * drawer, because it is the one a manager acts on at 02:00 with the notes in
 * their hand. Everything else explains it.
 */
export function DailyCloseOut({
  day,
  onDayChange,
}: {
  day: string;
  onDayChange: (day: string) => void;
}): JSX.Element {
  const state = useReport<DailyReportView>(
    `/reports/daily?businessDay=${encodeURIComponent(day)}`,
  );

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow mb-1.5">Close-out · {businessDayRelation(day)}</p>
          <h1 className="font-serif text-[28px] leading-tight text-ink">
            {businessDayLabel(day)}
          </h1>
        </div>
        <NightPicker day={day} onChange={onDayChange} />
      </div>

      <ReportFrame state={state}>{(report) => <CloseOutBody report={report} />}</ReportFrame>
    </div>
  );
}

function CloseOutBody({ report }: { report: DailyReportView }): JSX.Element {
  const { bookings, takings, tips, cashDrawer, therapists } = report;
  const methodScale = Math.max(1, ...takings.byMethod.map((line) => Math.abs(line.amountFils)));

  return (
    <div className="grid gap-4">
      {bookings.needingCheckout > 0 ? (
        <p className="rounded-xl border-2 border-alert bg-alert-pale px-4 py-3 text-[14px] leading-snug text-alert-deep">
          <strong className="font-semibold">
            {bookings.needingCheckout} booking{bookings.needingCheckout === 1 ? '' : 's'} left open.
          </strong>{' '}
          A treatment still in progress more than two hours after the room was released has not been
          checked out, so its tip is missing from everything below. Close them on the grid before
          counting the till.
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <Panel
          title="Expected in the drawer"
          hint="Count the till against this figure"
        >
          <p className="font-serif text-[44px] leading-none text-teal-700 numeric">
            {formatAed(cashDrawer.expectedCashFils)}
          </p>
          <dl className="mt-4 grid gap-1.5 text-[13.5px]">
            <DrawerLine label="Treatments paid in cash" fils={cashDrawer.baseCashFils} />
            <DrawerLine label="Tips added to a cash bill" fils={cashDrawer.tipCashFils} />
            <DrawerLine label="Refunded in cash" fils={cashDrawer.refundedCashFils} />
            <DrawerLine label="Cash adjustments" fils={cashDrawer.adjustmentCashFils} />
          </dl>
          <p className="mt-4 border-t border-line pt-3 text-[12.5px] leading-relaxed text-ink-muted">
            {cashDrawer.note}
          </p>
        </Panel>

        <Panel title="Taken tonight" hint="Every payment filed to this trading night">
          <Tiles>
            <Figure
              label="Treatments collected"
              fils={takings.baseCollectedFils}
              tone="revenue"
              sub="Base service, at the desk"
            />
            <Figure
              label="Tips on the bill"
              fils={takings.tipsCollectedFils}
              tone="payable"
              sub="Held for the therapist — not revenue"
            />
            <Figure
              label="Refunds"
              fils={takings.baseRefundedFils}
              tone={takings.baseRefundedFils < 0 ? 'alert' : 'ink'}
            />
            <Figure label="Adjustments" fils={takings.adjustmentsFils} sub="Discounts, corrections" />
          </Tiles>

          <div className="mt-4 grid gap-2.5">
            <p className="text-[11.5px] uppercase tracking-label text-ink-muted">
              Gross by method · {formatAed(takings.grossFils)}
            </p>
            {takings.byMethod.length === 0 ? (
              <p className="text-[13.5px] text-ink-muted">Nothing was taken on this night.</p>
            ) : (
              takings.byMethod.map((line) => (
                <div key={line.method} className="grid grid-cols-[110px_minmax(0,1fr)_110px] items-center gap-3">
                  <span className="text-[13px] text-ink-muted">{methodLabel(line.method)}</span>
                  <Bar
                    value={Math.abs(line.amountFils)}
                    scale={methodScale}
                    series={line.amountFils < 0 ? 'outside' : 'neutral'}
                    title={`${line.entries} payment${line.entries === 1 ? '' : 's'}`}
                  />
                  <span className="text-right text-[13.5px] text-ink numeric">
                    {formatAed(line.amountFils)}
                  </span>
                </div>
              ))
            )}
          </div>
        </Panel>
      </div>

      <Panel title="The night" hint="Bookings, guests and who was on the floor">
        <Tiles>
          <Count label="Guests seen" value={report.guestsSeen} sub="Arrived and treated" />
          <Count label="Treatments completed" value={bookings.completed} tone="revenue" />
          <Count label="No-shows" value={bookings.noShow} tone={bookings.noShow > 0 ? 'alert' : 'ink'} />
          <Count label="Cancellations" value={bookings.cancelled} />
        </Tiles>
        <Tiles>
          <Count label="Still in a room" value={bookings.inProgress} />
          <Count label="Yet to arrive" value={bookings.scheduled} />
          <Count
            label="Therapists worked"
            value={therapists.worked}
            sub={`${therapists.rostered} rostered`}
          />
          <Count label="Bookings in total" value={bookings.total} />
        </Tiles>
      </Panel>

      <Panel title="Tips tonight" hint="Two modes, kept apart on purpose (§9.1)">
        <Table
          head={
            <>
              <Th>Mode</Th>
              <Th numeric>Tips</Th>
              <Th numeric>Amount</Th>
              <Th width="46%">Who is holding it now</Th>
            </>
          }
        >
          <Row>
            <Td>Handed to the therapist</Td>
            <Td numeric muted>{tips.directCash.tipCount}</Td>
            <Td numeric>{formatAed(tips.directCash.totalFils)}</Td>
            <Td muted>{tips.labels.directCash}</Td>
          </Row>
          <Row>
            <Td>Added to the bill</Td>
            <Td numeric muted>{tips.collectedByBusiness.tipCount}</Td>
            <Td numeric>{formatAed(tips.collectedByBusiness.totalFils)}</Td>
            <Td muted>{tips.labels.collectedByBusiness}</Td>
          </Row>
          <Row total>
            <Td>Earned by therapists tonight</Td>
            <Td numeric>{tips.directCash.tipCount + tips.collectedByBusiness.tipCount}</Td>
            <Td numeric>{formatAed(tips.totalFils)}</Td>
            <Td muted>
              Of which <strong className="font-medium text-gold-deep">{formatAed(tips.payableFils)}</strong>{' '}
              is owed out by BE RELAX
            </Td>
          </Row>
        </Table>
        <div className="mt-4">
          <Basis>
            The two lines are never added into a payout. A tip handed over in cash is already in the
            therapist&rsquo;s pocket; paying it again at the end of the month is how a spa pays a
            tip twice.
          </Basis>
        </div>
      </Panel>
    </div>
  );
}

function DrawerLine({ label, fils }: { label: string; fils: number }): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line py-1 last:border-b-0">
      <dt className="text-ink-muted">{label}</dt>
      <dd className={`numeric ${fils < 0 ? 'text-alert-deep' : 'text-ink'}`}>{formatAed(fils)}</dd>
    </div>
  );
}

const METHOD_LABELS: Record<string, string> = {
  CASH: 'Cash',
  CARD: 'Card',
  BANK_TRANSFER: 'Transfer',
  VOUCHER: 'Voucher',
  COMPLIMENTARY: 'Comp',
};

/** Degrade rather than die if the API ever grows a method this build predates. */
function methodLabel(method: string): string {
  return METHOD_LABELS[method] ?? method.replace(/_/g, ' ').toLowerCase();
}
