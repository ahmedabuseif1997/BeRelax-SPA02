'use client';

import { formatAed } from '@berelax/contracts';
import type { ReservationView } from '@/lib/api-types';
import {
  PX_PER_MINUTE,
  dubaiTime,
  minutesFromOpen,
  needsCheckout,
  overdueBy,
} from '@/lib/grid-time';
import { skinFor } from '../ui/status';

export interface BlockLayout {
  /** 0-based lane within a cluster of overlapping blocks. */
  lane: number;
  lanes: number;
}

/** A booking on the grid. Big enough to hit with a thumb, quiet enough to scan. */
export function ReservationBlock({
  reservation,
  day,
  layout,
  now,
  onOpen,
}: {
  reservation: ReservationView;
  day: string;
  layout: BlockLayout;
  now: Date;
  onOpen: (reservation: ReservationView) => void;
}): JSX.Element {
  const startMinutes = minutesFromOpen(reservation.startsAt, day);
  const endMinutes = minutesFromOpen(reservation.endsAt, day);
  const blockedMinutes = minutesFromOpen(reservation.blockedUntil, day);

  const top = startMinutes * PX_PER_MINUTE;
  // A 30-minute treatment is 48px; never let a short one shrink below a thumb.
  const height = Math.max((endMinutes - startMinutes) * PX_PER_MINUTE, 44);
  const bufferHeight = Math.max((blockedMinutes - endMinutes) * PX_PER_MINUTE, 0);

  const overdue = needsCheckout(reservation, now);
  const skin = skinFor(reservation.status);
  const width = `calc(${100 / layout.lanes}% - 6px)`;
  const left = `calc(${(layout.lane * 100) / layout.lanes}% + 3px)`;
  const guest = reservation.guest?.fullName ?? 'Walk-in';
  const compact = height < 66;

  return (
    <>
      {bufferHeight > 0 ? (
        <div
          aria-hidden="true"
          title="Turnaround — the slot is not free yet"
          style={{
            top: `${top + height}px`,
            height: `${bufferHeight}px`,
            width,
            left,
            backgroundImage:
              'repeating-linear-gradient(135deg, rgba(110,103,93,.14) 0 5px, transparent 5px 10px)',
          }}
          className="pointer-events-none absolute rounded-b-lg"
        />
      ) : null}

      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onOpen(reservation);
        }}
        style={{ top: `${top}px`, height: `${height}px`, width, left }}
        className={[
          'absolute overflow-hidden rounded-lg border px-2.5 py-1.5 text-left transition-colors',
          skin.block,
          overdue ? 'border-2 border-alert bg-alert-pale text-alert-deep' : '',
          reservation.status === 'CANCELLED' ? 'line-through decoration-1' : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        <span className="flex items-baseline justify-between gap-1.5">
          <span className="text-[12px] font-medium numeric">
            {dubaiTime(reservation.startsAt)}
          </span>
          <span className="truncate text-[11px] opacity-70 numeric">
            {formatAed(reservation.baseCostFils)}
          </span>
        </span>

        <span className="mt-0.5 block truncate text-[14.5px] font-medium leading-tight">
          {guest}
        </span>

        {compact ? null : (
          <span className="mt-0.5 block truncate text-[12.5px] opacity-75">
            {reservation.service?.name ?? 'Treatment'}
            {reservation.room ? ` · ${reservation.room.name}` : ''}
          </span>
        )}

        {overdue ? (
          <span className="mt-1 block truncate text-[11px] font-semibold uppercase tracking-label">
            Needs checkout · {overdueBy(reservation, now)}
          </span>
        ) : null}
      </button>
    </>
  );
}
