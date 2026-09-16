'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { EmployeeRef, EmployeeSummary, ReservationView } from '@/lib/api-types';
import {
  PX_PER_MINUTE,
  SLOT_MINUTES,
  TRADING_MINUTES,
  dubaiTime,
  isOutsideTradingHours,
  minutesFromOpen,
  nowOffsetMinutes,
  slotInstant,
  slotLabels,
} from '@/lib/grid-time';
import { ReservationBlock, type BlockLayout } from './reservation-block';
import { StatusPill } from '../ui/status';

/**
 * Therapists across, the trading day down: 11:00 at the top, 02:00 at the
 * bottom. A 01:30 booking sits at the BOTTOM of tonight's grid — never at the
 * top of tomorrow's — because every position is measured from 11:00 on the
 * reservation's own trading day. Spec §3.3.
 */

const RAIL_PX = 68;
const COLUMN_MIN_PX = 168;
const BODY_HEIGHT_PX = TRADING_MINUTES * PX_PER_MINUTE;

/** Tapping an empty stretch of a therapist's column starts a booking there. */
const TAP_SLOT_MINUTES = 15;

export function BookingGrid({
  day,
  reservations,
  employees,
  onOpenReservation,
  onOpenSlot,
}: {
  day: string;
  reservations: readonly ReservationView[];
  /** Catalogue staff, when the API will give them to this role. */
  employees: readonly EmployeeSummary[];
  onOpenReservation: (reservation: ReservationView) => void;
  /** Null when this user cannot create bookings, or writes are disabled. */
  onOpenSlot: ((employeeId: string, startsAt: Date) => void) | null;
}): JSX.Element {
  const [now, setNow] = useState(() => new Date());
  const scroller = useRef<HTMLDivElement>(null);
  const scrolledFor = useRef<string | null>(null);

  // The needs-checkout badge and the now-line are both time-of-day facts, so
  // the grid re-reads the clock even when no data has changed.
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const columns = useMemo(() => buildColumns(reservations, employees), [reservations, employees]);
  const slots = useMemo(() => slotLabels(day), [day]);

  const onScreen = useMemo(
    () => reservations.filter((r) => !isOutsideTradingHours(r, day)),
    [reservations, day],
  );
  const offScreen = useMemo(
    () => reservations.filter((r) => isOutsideTradingHours(r, day)),
    [reservations, day],
  );

  const byEmployee = useMemo(() => {
    const map = new Map<string, ReservationView[]>();
    for (const reservation of onScreen) {
      const key = reservation.employee?.id ?? 'unassigned';
      const bucket = map.get(key);
      if (bucket) bucket.push(reservation);
      else map.set(key, [reservation]);
    }
    return map;
  }, [onScreen]);

  const nowMinutes = nowOffsetMinutes(day, now);

  // Open on the current hour rather than at 11:00: the desk is usually looking
  // at the next two treatments, not at lunchtime.
  useEffect(() => {
    if (scrolledFor.current === day || nowMinutes === null || !scroller.current) return;
    scrolledFor.current = day;
    scroller.current.scrollTop = Math.max((nowMinutes - 60) * PX_PER_MINUTE, 0);
  }, [day, nowMinutes]);

  if (columns.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 py-16">
        <div className="max-w-[420px] text-center">
          <p className="font-serif text-[24px] text-ink">Nothing on the grid</p>
          <p className="mt-2 text-[15px] leading-snug text-ink-muted">
            No bookings for this trading day, and the API has not given this account a therapist
            list to lay out empty columns from.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {offScreen.length > 0 ? (
        <OutsideHours reservations={offScreen} onOpen={onOpenReservation} />
      ) : null}

      <div ref={scroller} className="grid-scroll min-h-0 flex-1 overflow-auto">
        <div
          className="relative grid"
          style={{
            gridTemplateColumns: `${RAIL_PX}px repeat(${columns.length}, minmax(${COLUMN_MIN_PX}px, 1fr))`,
          }}
        >
          <div className="sticky left-0 top-0 z-30 border-b border-r border-line bg-cream" />
          {columns.map((column) => (
            <div
              key={column.id}
              className="sticky top-0 z-20 border-b border-r border-line bg-cream px-3 py-2.5"
            >
              <p className="truncate text-[14.5px] font-medium text-ink">{column.displayName}</p>
              <p className="text-[11px] uppercase tracking-label text-ink-muted numeric">
                {countFor(byEmployee, column.id)} booked
              </p>
            </div>
          ))}

          <div
            className="sticky left-0 z-10 border-r border-line bg-cream"
            style={{ height: `${BODY_HEIGHT_PX}px` }}
          >
            {slots.map((slot) => (
              <div
                key={slot.minutes}
                style={{ top: `${slot.minutes * PX_PER_MINUTE}px` }}
                className={`absolute right-2 -translate-y-1/2 text-[11.5px] numeric ${
                  slot.isHour ? 'font-medium text-ink-muted' : 'text-ink-muted/55'
                }`}
              >
                {slot.label}
              </div>
            ))}
          </div>

          {columns.map((column) => (
            <Column
              key={column.id}
              day={day}
              now={now}
              nowMinutes={nowMinutes}
              reservations={byEmployee.get(column.id) ?? []}
              onOpenReservation={onOpenReservation}
              onOpenSlot={onOpenSlot ? (at) => onOpenSlot(column.id, at) : null}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function Column({
  day,
  now,
  nowMinutes,
  reservations,
  onOpenReservation,
  onOpenSlot,
}: {
  day: string;
  now: Date;
  nowMinutes: number | null;
  reservations: readonly ReservationView[];
  onOpenReservation: (reservation: ReservationView) => void;
  onOpenSlot: ((startsAt: Date) => void) | null;
}): JSX.Element {
  const cell = useRef<HTMLDivElement>(null);
  const layouts = useMemo(() => laneLayout(reservations, day), [reservations, day]);

  const handleTap = (clientY: number): void => {
    if (!onOpenSlot || !cell.current) return;
    const rect = cell.current.getBoundingClientRect();
    const minutes = (clientY - rect.top) / PX_PER_MINUTE;
    if (minutes < 0 || minutes >= TRADING_MINUTES) return;
    const snapped = Math.floor(minutes / TAP_SLOT_MINUTES) * TAP_SLOT_MINUTES;
    // Built from the trading day's opening instant, so a tap at the bottom of
    // the grid produces 01:30 tomorrow morning, on tonight's business day.
    onOpenSlot(slotInstant(day, snapped));
  };

  return (
    <div
      ref={cell}
      onClick={(event) => handleTap(event.clientY)}
      style={{
        height: `${BODY_HEIGHT_PX}px`,
        backgroundImage:
          'repeating-linear-gradient(to bottom, #EFE6D8 0px, #EFE6D8 1px, transparent 1px, transparent ' +
          `${SLOT_MINUTES * PX_PER_MINUTE}px), ` +
          'repeating-linear-gradient(to bottom, #E6D8C4 0px, #E6D8C4 1px, transparent 1px, transparent ' +
          `${60 * PX_PER_MINUTE}px)`,
      }}
      className={`relative border-r border-line ${onOpenSlot ? 'cursor-copy' : ''}`}
    >
      {reservations.map((reservation) => (
        <ReservationBlock
          key={reservation.id}
          reservation={reservation}
          day={day}
          now={now}
          layout={layouts.get(reservation.id) ?? { lane: 0, lanes: 1 }}
          onOpen={onOpenReservation}
        />
      ))}

      {nowMinutes !== null ? (
        <div
          aria-hidden="true"
          style={{ top: `${nowMinutes * PX_PER_MINUTE}px` }}
          className="pointer-events-none absolute inset-x-0 h-px bg-gold"
        />
      ) : null}
    </div>
  );
}

function OutsideHours({
  reservations,
  onOpen,
}: {
  reservations: readonly ReservationView[];
  onOpen: (reservation: ReservationView) => void;
}): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-gold-light bg-gold-pale px-4 py-2.5 sm:px-6">
      <span className="text-[12.5px] font-medium uppercase tracking-label text-gold-deep">
        Outside 11:00–02:00
      </span>
      {reservations.map((reservation) => (
        <button
          key={reservation.id}
          type="button"
          onClick={() => onOpen(reservation)}
          className="inline-flex min-h-[38px] items-center gap-2 rounded-full border border-gold-light bg-white px-3 text-[13px] text-ink"
        >
          <span className="numeric">{dubaiTime(reservation.startsAt)}</span>
          <span className="max-w-[160px] truncate">
            {reservation.guest?.fullName ?? 'Walk-in'}
          </span>
          <StatusPill status={reservation.status} />
        </button>
      ))}
    </div>
  );
}

/* ───────────────────────── layout helpers ───────────────────────── */

interface TherapistColumn {
  id: string;
  displayName: string;
}

/**
 * Columns are the therapists on shift for this trading day (from
 * `/availability`, which every staff role may read), plus anyone who has a
 * booking without a shift row — so a therapist called in late still gets a
 * column rather than having their bookings vanish.
 */
function buildColumns(
  reservations: readonly ReservationView[],
  employees: readonly EmployeeSummary[],
): TherapistColumn[] {
  const columns = new Map<string, TherapistColumn>();
  for (const employee of employees) {
    columns.set(employee.id, { id: employee.id, displayName: employee.displayName });
  }
  for (const reservation of reservations) {
    const employee: EmployeeRef | null | undefined = reservation.employee;
    if (employee && !columns.has(employee.id)) {
      columns.set(employee.id, { id: employee.id, displayName: employee.displayName });
    }
  }
  return [...columns.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function countFor(byEmployee: Map<string, ReservationView[]>, employeeId: string): number {
  return (byEmployee.get(employeeId) ?? []).filter(
    (r) => r.status !== 'CANCELLED' && r.status !== 'NO_SHOW',
  ).length;
}

/**
 * The database will not let two live bookings overlap for one therapist, but a
 * cancelled one releases its slot — so an overlap on screen is real and both
 * have to stay readable. Overlapping blocks share the column width.
 */
function laneLayout(
  reservations: readonly ReservationView[],
  day: string,
): Map<string, BlockLayout> {
  const ordered = [...reservations].sort(
    (a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt),
  );
  const layouts = new Map<string, BlockLayout>();

  let cluster: ReservationView[] = [];
  let clusterEnd = -Infinity;

  const flush = (): void => {
    cluster.forEach((reservation, index) => {
      layouts.set(reservation.id, { lane: index, lanes: cluster.length });
    });
    cluster = [];
    clusterEnd = -Infinity;
  };

  for (const reservation of ordered) {
    const start = minutesFromOpen(reservation.startsAt, day);
    const end = minutesFromOpen(reservation.blockedUntil, day);
    if (cluster.length > 0 && start >= clusterEnd) flush();
    cluster.push(reservation);
    clusterEnd = Math.max(clusterEnd, end);
  }
  flush();

  return layouts;
}
