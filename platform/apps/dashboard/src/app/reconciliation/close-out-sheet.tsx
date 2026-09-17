'use client';

import { formatAed } from '@berelax/contracts';
import {
  Basis,
  Count,
  Figure,
  Panel,
  Row,
  Table,
  Td,
  Th,
  Tiles,
} from '@/components/reports/report-ui';
import type { CloseOutSheetView } from './types';

/**
 * The close-out sheet, laid out to be printed and ticked off.
 *
 * Dense on purpose: every figure reception's paper also has, in the order they
 * will look for them, with nothing to interpret. The two tip modes are kept
 * apart the way §9.1 keeps them apart — a tip handed to a therapist is not in
 * the drawer and is not owed out, and putting the two in one total is how a spa
 * pays a tip twice.
 */
export function CloseOutSheet({ sheet }: { sheet: CloseOutSheetView }): JSX.Element {
  return (
    <div className="grid gap-4">
      {sheet.warnings.map((warning) => (
        <p
          key={warning}
          className="rounded-xl border-2 border-alert bg-alert-pale px-4 py-3 text-[14px] leading-snug text-alert-deep"
        >
          {warning}
        </p>
      ))}

      {sheet.isTonight ? (
        <p className="rounded-xl border border-line bg-oat-light px-4 py-3 text-[13.5px] leading-snug text-ink-soft">
          This is <strong className="font-medium">tonight</strong>, and it is not over. These
          figures will keep moving until the last guest is checked out. Reconcile after close.
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Cash expected in the drawer" hint="Count the till against this">
          <p className="font-serif text-[40px] leading-none text-teal-700 numeric">
            {formatAed(sheet.cash.expectedCashFils)}
          </p>
          <dl className="mt-4 grid gap-1.5 text-[13.5px]">
            <MoneyLine label="Treatments paid in cash" fils={sheet.cash.baseCashFils} />
            <MoneyLine label="Tips added to a cash bill" fils={sheet.cash.tipCashFils} />
            <MoneyLine label="Refunded in cash" fils={sheet.cash.refundedCashFils} />
            <MoneyLine label="Cash adjustments" fils={sheet.cash.adjustmentCashFils} />
          </dl>
          <p className="mt-4 border-t border-line pt-3 text-[12.5px] leading-relaxed text-ink-muted">
            {sheet.cash.note}
          </p>
        </Panel>

        <Panel title="Card terminal total" hint="Check against the Z-report, to the fil">
          <p className="font-serif text-[40px] leading-none text-teal-700 numeric">
            {formatAed(sheet.card.expectedCardFils)}
          </p>
          <dl className="mt-4 grid gap-1.5 text-[13.5px]">
            <MoneyLine label="Treatments paid by card" fils={sheet.card.baseCardFils} />
            <MoneyLine label="Tips added to a card bill" fils={sheet.card.tipCardFils} />
            <MoneyLine label="Refunded on the terminal" fils={sheet.card.refundedCardFils} />
            <MoneyLine label="Card adjustments" fils={sheet.card.adjustmentCardFils} />
          </dl>
          <p className="mt-4 border-t border-line pt-3 text-[12.5px] leading-relaxed text-ink-muted">
            {sheet.card.note}
          </p>
        </Panel>
      </div>

      <Panel title="The night" hint="What to count on the paper sheet">
        <Tiles>
          <Count
            label="Sessions that took place"
            value={sheet.guestsSeen}
            tone="revenue"
            sub="Treated, or still in a room"
          />
          <Count label="No-shows" value={sheet.bookings.noShow} sub="Not on the sheet" />
          <Count label="Cancellations" value={sheet.bookings.cancelled} sub="Not on the sheet" />
          <Count
            label="Therapists worked"
            value={sheet.therapists.worked}
            sub={`${sheet.therapists.rostered} rostered`}
          />
        </Tiles>
        <div className="mt-3">
          <Basis>
            The session count on the paper sheet is the first tile only. A cancellation was
            never a treatment and a no-show never arrived; counting them is the most common
            reason a night looks one or two out.
          </Basis>
        </div>
      </Panel>

      <Panel title="Tips tonight" hint="Two modes, kept apart on purpose (§9.1)">
        <Tiles>
          <Figure
            label="Handed to the therapist"
            fils={sheet.tips.directCash.totalFils}
            tone="outside"
            sub={`${sheet.tips.directCash.tipCount} tips · never entered the till`}
          />
          <Figure
            label="Added to the bill"
            fils={sheet.tips.collectedByBusiness.totalFils}
            tone="payable"
            sub={`${sheet.tips.collectedByBusiness.tipCount} tips · held by BE RELAX`}
          />
          <Figure
            label="Earned tonight"
            fils={sheet.tips.totalFils}
            sub="Both modes together"
          />
          <Figure
            label="Owed out"
            fils={sheet.tips.payableFils}
            tone="payable"
            sub="Only what the business is holding"
          />
        </Tiles>
      </Panel>

      <Panel title="By therapist" hint="The column reception reads across">
        <Table
          head={
            <>
              <Th width="26%">Therapist</Th>
              <Th numeric>Sessions</Th>
              <Th numeric>No-show</Th>
              <Th numeric>Cancelled</Th>
              <Th numeric>Tips handed over</Th>
              <Th numeric>Tips on the bill</Th>
            </>
          }
        >
          {sheet.byTherapist.length === 0 ? (
            <Row>
              <Td muted>Nothing recorded against this night.</Td>
              <Td numeric muted>—</Td>
              <Td numeric muted>—</Td>
              <Td numeric muted>—</Td>
              <Td numeric muted>—</Td>
              <Td numeric muted>—</Td>
            </Row>
          ) : (
            sheet.byTherapist.map((line) => (
              <Row key={line.employeeId}>
                <Td>{line.displayName}</Td>
                <Td numeric>{line.sessions}</Td>
                <Td numeric muted={line.noShow === 0}>{line.noShow}</Td>
                <Td numeric muted={line.cancelled === 0}>{line.cancelled}</Td>
                <Td numeric>{formatAed(line.tipsDirectCashFils)}</Td>
                <Td numeric>{formatAed(line.tipsCollectedByBusinessFils)}</Td>
              </Row>
            ))
          )}
        </Table>
      </Panel>

      <Panel
        title="Still in a room"
        hint="Close these before signing the night off"
      >
        {sheet.openSessions.length === 0 ? (
          <p className="text-[14px] text-ink-muted">
            Nothing is open. Every treatment on this night was checked out.
          </p>
        ) : (
          <Table
            head={
              <>
                <Th>Booking</Th>
                <Th>Therapist</Th>
                <Th>Room</Th>
                <Th>Started</Th>
                <Th numeric>Treatment</Th>
              </>
            }
          >
            {sheet.openSessions.map((session) => (
              <Row key={session.reservationId}>
                <Td>
                  <span className="numeric">{session.ref}</span>
                  {session.overdue ? (
                    <span className="ml-2 rounded-full bg-alert px-2 py-0.5 text-[11px] uppercase tracking-label text-white">
                      overdue
                    </span>
                  ) : null}
                </Td>
                <Td>{session.therapist}</Td>
                <Td muted>{session.room ?? '—'}</Td>
                <Td muted>
                  {new Date(session.startsAt).toLocaleTimeString('en-AE', {
                    timeZone: 'Asia/Dubai',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </Td>
                <Td numeric>{formatAed(session.baseCostFils)}</Td>
              </Row>
            ))}
          </Table>
        )}
      </Panel>

      <Panel title="Who took cash at the desk" hint="A variance belongs to somebody (§15.4)">
        {sheet.cashDesk.length === 0 ? (
          <p className="text-[14px] text-ink-muted">No cash was taken on this night.</p>
        ) : (
          <Table
            head={
              <>
                <Th width="45%">Name</Th>
                <Th numeric>Payments</Th>
                <Th numeric>Cash through their hands</Th>
              </>
            }
          >
            {sheet.cashDesk.map((desk) => (
              <Row key={desk.userId}>
                <Td>{desk.fullName}</Td>
                <Td numeric muted>{desk.entries}</Td>
                <Td numeric>{formatAed(desk.amountFils)}</Td>
              </Row>
            ))}
          </Table>
        )}
        <div className="mt-4">
          <Basis>
            The system records that cash was collected; it cannot prove the cash reached the
            drawer. What it can do is name who was taking it, so a pattern across a fortnight
            is visible rather than anecdotal. That is as far as software goes — the rest is a
            camera and a drawer count.
          </Basis>
        </div>
      </Panel>
    </div>
  );
}

function MoneyLine({ label, fils }: { label: string; fils: number }): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line py-1 last:border-b-0">
      <dt className="text-ink-muted">{label}</dt>
      <dd className={`numeric ${fils < 0 ? 'text-alert-deep' : 'text-ink'}`}>
        {formatAed(fils)}
      </dd>
    </div>
  );
}
