'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatAed } from '@berelax/contracts';
import { AppShell } from '@/components/app-shell';
import { BookingGrid } from '@/components/grid/booking-grid';
import { DayBar } from '@/components/grid/day-bar';
import { StaleBanner } from '@/components/stale-banner';
import { CheckInSheet } from '@/components/sheets/check-in-sheet';
import { CheckoutSheet } from '@/components/sheets/checkout-sheet';
import { NewBookingSheet, type NewBookingPrefill } from '@/components/sheets/new-booking-sheet';
import { ReservationSheet } from '@/components/sheets/reservation-sheet';
import { Button } from '@/components/ui/button';
import type { EmployeeSummary, ReservationView } from '@/lib/api-types';
import { useAuth } from '@/lib/auth-context';
import { useCatalogue } from '@/lib/catalogue';
import { needsCheckout } from '@/lib/grid-time';
import { ReservationsProvider, useReservations } from '@/lib/reservations-context';
import { can } from '@/lib/roles';

export default function HomePage(): JSX.Element {
  return (
    <AppShell requires="grid.view">
      <ReservationsProvider>
        <GridScreen />
      </ReservationsProvider>
    </AppShell>
  );
}

type OpenSheet =
  | { kind: 'detail'; reservation: ReservationView }
  | { kind: 'check-in'; reservation: ReservationView }
  | { kind: 'checkout'; reservation: ReservationView }
  | { kind: 'new'; prefill: NewBookingPrefill }
  | null;

function GridScreen(): JSX.Element {
  const { user } = useAuth();
  const { day, reservations, writesEnabled, unavailable, failureMessage, refresh, applyReservation } =
    useReservations();
  const catalogue = useCatalogue(day);
  const [sheet, setSheet] = useState<OpenSheet>(null);
  const [flash, setFlash] = useState<string | null>(null);

  useEffect(() => {
    if (flash === null) return;
    const timer = setTimeout(() => setFlash(null), 6_000);
    return () => clearTimeout(timer);
  }, [flash]);

  /**
   * Tonight's roster from `/availability`, plus anyone who already has a booking
   * but no shift row — a therapist called in at 22:00 must still be bookable.
   */
  const therapists = useMemo<EmployeeSummary[]>(() => {
    const merged = new Map<string, EmployeeSummary>();
    for (const employee of catalogue.therapists) merged.set(employee.id, employee);
    for (const reservation of reservations) {
      const employee = reservation.employee;
      if (employee && !merged.has(employee.id)) merged.set(employee.id, { ...employee });
    }
    return [...merged.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [catalogue.therapists, reservations]);

  // §8.4: IN_PROGRESS more than two hours past `blockedUntil`. Surfaced at the
  // top as well as on the grid, because it is tomorrow's report being wrong.
  const overdue = useMemo(() => reservations.filter((r) => needsCheckout(r)), [reservations]);

  const mayCreate = can(user?.role, 'reservation.create');
  const canOpenNewBooking = mayCreate && writesEnabled && catalogue.services.length > 0;

  const openSlot = useCallback(
    (employeeId: string, startsAt: Date) => setSheet({ kind: 'new', prefill: { employeeId, startsAt } }),
    [],
  );

  const newBookingDisabledReason = !mayCreate
    ? null
    : !writesEnabled
      ? 'New bookings are off while the system is unreachable.'
      : catalogue.loading
        ? 'Loading the menu…'
        : (catalogue.unavailableReason ?? null);

  if (unavailable) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 py-16">
        <div className="max-w-[460px] text-center">
          <h1 className="font-serif text-[28px] text-ink">The booking system is not answering</h1>
          <p className="mt-3 text-[15px] leading-snug text-ink-muted">
            {failureMessage} Nothing has been lost — this screen simply has nothing to show for
            this trading day yet. Taking payments is switched off until it is back.
          </p>
          <Button variant="primary" size="lg" className="mt-6" onClick={() => void refresh()}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  return (
    <>
      <StaleBanner />
      <DayBar
        needsCheckout={overdue}
        onOpenNeedsCheckout={(reservation) => setSheet({ kind: 'checkout', reservation })}
        onNewBooking={canOpenNewBooking ? () => setSheet({ kind: 'new', prefill: {} }) : null}
        newBookingDisabledReason={newBookingDisabledReason}
      />

      <BookingGrid
        day={day}
        reservations={reservations}
        employees={therapists}
        onOpenReservation={(reservation) => setSheet({ kind: 'detail', reservation })}
        onOpenSlot={canOpenNewBooking ? openSlot : null}
      />

      {sheet?.kind === 'detail' ? (
        <ReservationSheet
          reservation={current(sheet.reservation, reservations)}
          onClose={() => setSheet(null)}
          onCheckIn={() => setSheet({ kind: 'check-in', reservation: sheet.reservation })}
          onCheckout={() => setSheet({ kind: 'checkout', reservation: sheet.reservation })}
        />
      ) : null}

      {sheet?.kind === 'check-in' ? (
        <CheckInSheet
          reservation={current(sheet.reservation, reservations)}
          onClose={() => setSheet(null)}
          onCheckedIn={(result) => {
            applyReservation(result);
            void refresh();
            setSheet(null);
            setFlash(
              `${result.guest?.fullName ?? 'Walk-in'} checked in · ${formatAed(result.basePaidFils)} taken`,
            );
          }}
        />
      ) : null}

      {sheet?.kind === 'checkout' ? (
        <CheckoutSheet
          reservation={current(sheet.reservation, reservations)}
          onClose={() => setSheet(null)}
          onCheckedOut={(result) => {
            applyReservation(result);
            void refresh();
            setSheet(null);
            setFlash(
              result.totals.tipFils > 0
                ? `Checked out · ${formatAed(result.totals.tipFils)} tip recorded`
                : 'Checked out · no tip',
            );
          }}
        />
      ) : null}

      {sheet?.kind === 'new' ? (
        <NewBookingSheet
          prefill={sheet.prefill}
          services={catalogue.services}
          employees={therapists}
          rooms={catalogue.rooms}
          onClose={() => setSheet(null)}
          onCreated={(reservation) => {
            setSheet(null);
            setFlash(`Booked ${reservation.ref} · ${reservation.guest?.fullName ?? 'Walk-in'}`);
          }}
        />
      ) : null}

      {flash ? (
        <div
          role="status"
          className="pointer-events-none fixed inset-x-0 bottom-6 z-[60] flex justify-center px-4"
        >
          <p className="rounded-full border border-teal-600 bg-teal-700 px-5 py-3 text-[15px] font-medium text-white shadow-lg">
            {flash}
          </p>
        </div>
      ) : null}
    </>
  );
}

/**
 * Sheets hold the reservation they were opened with; the grid refetches every
 * 30 seconds underneath them. Always render the freshest copy so a status that
 * moved on another iPad is not hidden behind an open sheet.
 */
function current(
  reservation: ReservationView,
  reservations: readonly ReservationView[],
): ReservationView {
  return reservations.find((row) => row.id === reservation.id) ?? reservation;
}
