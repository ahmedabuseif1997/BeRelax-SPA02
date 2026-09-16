'use client';

import type { ReservationView } from '@/lib/api-types';
import {
  businessDayLabel,
  businessDayRelation,
  currentBusinessDay,
  shiftBusinessDay,
} from '@/lib/grid-time';
import { useReservations } from '@/lib/reservations-context';
import { Button } from '../ui/button';

/**
 * The trading day, not the calendar day. "Tonight" runs 11:00 to 02:00, so at
 * 01:00 on Tuesday morning the desk is still working Monday's grid — and this
 * bar says so rather than quietly rolling over at midnight. Spec §3.3.
 */
export function DayBar({
  needsCheckout,
  onOpenNeedsCheckout,
  onNewBooking,
  newBookingDisabledReason,
}: {
  needsCheckout: readonly ReservationView[];
  onOpenNeedsCheckout: (reservation: ReservationView) => void;
  onNewBooking: (() => void) | null;
  newBookingDisabledReason: string | null;
}): JSX.Element {
  const { day, setDay, isToday, reservations, loading, lastSuccessAt } = useReservations();

  const live = reservations.filter((r) => r.status !== 'CANCELLED' && r.status !== 'NO_SHOW');
  const inProgress = live.filter((r) => r.status === 'IN_PROGRESS').length;

  return (
    <div className="border-b border-line bg-oat-light">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 px-4 py-3 sm:px-6">
        <div className="flex items-center gap-1">
          <ArrowButton
            label="Previous day"
            glyph="‹"
            onClick={() => setDay(shiftBusinessDay(day, -1))}
          />
          <ArrowButton label="Next day" glyph="›" onClick={() => setDay(shiftBusinessDay(day, 1))} />
        </div>

        <div className="min-w-0">
          <p className="font-serif text-[24px] leading-none text-ink">
            {businessDayRelation(day)}
          </p>
          <p className="mt-1 text-[12.5px] text-ink-muted">
            {businessDayLabel(day)} · trading day 11:00–02:00
          </p>
        </div>

        {!isToday ? (
          <Button variant="secondary" size="md" onClick={() => setDay(currentBusinessDay())}>
            Back to tonight
          </Button>
        ) : null}

        <div className="flex items-center gap-4 text-[13px] text-ink-muted numeric">
          <span>
            <strong className="text-[16px] font-medium text-ink">{live.length}</strong> booked
          </span>
          <span>
            <strong className="text-[16px] font-medium text-teal-700">{inProgress}</strong> in room
          </span>
          {loading && lastSuccessAt === null ? <span>loading…</span> : null}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {onNewBooking ? (
            <Button variant="primary" size="lg" onClick={onNewBooking}>
              + New booking
            </Button>
          ) : (
            <span
              title={newBookingDisabledReason ?? undefined}
              className="max-w-[320px] text-right text-[12.5px] leading-snug text-ink-muted"
            >
              {newBookingDisabledReason}
            </span>
          )}
        </div>
      </div>

      {needsCheckout.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-alert-line bg-alert-pale px-4 py-2.5 sm:px-6">
          <span className="text-[12.5px] font-semibold uppercase tracking-label text-alert-deep">
            {needsCheckout.length} need{needsCheckout.length === 1 ? 's' : ''} checkout
          </span>
          {needsCheckout.map((reservation) => (
            <button
              key={reservation.id}
              type="button"
              onClick={() => onOpenNeedsCheckout(reservation)}
              className="inline-flex min-h-[38px] items-center gap-2 rounded-full border border-alert bg-white px-3 text-[13px] text-alert-deep hover:bg-alert-pale"
            >
              <span className="max-w-[150px] truncate">
                {reservation.guest?.fullName ?? 'Walk-in'}
              </span>
              <span className="opacity-70">{reservation.employee?.displayName}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ArrowButton({
  label,
  glyph,
  onClick,
}: {
  label: string;
  glyph: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="flex h-11 w-11 items-center justify-center rounded-full border border-line bg-white text-[20px] leading-none text-ink-muted transition-colors hover:border-line-strong hover:text-ink"
    >
      {glyph}
    </button>
  );
}
