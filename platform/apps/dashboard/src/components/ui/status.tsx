'use client';

import type { ReservationStatus } from '@berelax/contracts';
import type { ReactNode } from 'react';

/**
 * Status colour, in one place, so the grid, the sheets and the badges cannot
 * drift apart. Red is reserved for one thing only: a booking that needs
 * checking out (§8.4).
 */
export interface StatusSkin {
  label: string;
  /** The block on the grid. */
  block: string;
  /** A small pill. */
  pill: string;
}

export const STATUS_SKIN: Record<ReservationStatus, StatusSkin> = {
  SCHEDULED: {
    label: 'Scheduled',
    block: 'bg-white border-line-strong text-ink hover:border-teal-500',
    pill: 'bg-oat text-ink-muted border-line-strong',
  },
  IN_PROGRESS: {
    label: 'In progress',
    block: 'bg-teal-100 border-teal-500 text-teal-900 hover:border-teal-600',
    pill: 'bg-teal-100 text-teal-700 border-teal-300',
  },
  COMPLETED: {
    label: 'Completed',
    block: 'bg-oat-light border-line text-ink-muted',
    pill: 'bg-oat-light text-ink-muted border-line',
  },
  CANCELLED: {
    label: 'Cancelled',
    block: 'bg-oat-light border-line text-ink-muted opacity-70',
    pill: 'bg-oat-light text-ink-muted border-line',
  },
  NO_SHOW: {
    label: 'No-show',
    block: 'bg-gold-pale border-gold-light text-gold-deep',
    pill: 'bg-gold-pale text-gold-deep border-gold-light',
  },
};

/**
 * Degrade rather than die: if a later API adds a status this build has never
 * heard of, the booking still draws — neutrally, labelled with what the server
 * called it — instead of crashing the grid. Spec §12.2.
 */
export function skinFor(status: ReservationStatus | string): StatusSkin {
  const known = STATUS_SKIN[status as ReservationStatus];
  if (known) return known;
  return {
    label: String(status).replace(/_/g, ' ').toLowerCase(),
    block: 'bg-white border-line text-ink-muted',
    pill: 'bg-oat text-ink-muted border-line',
  };
}

export function StatusPill({
  status,
  children,
}: {
  status: ReservationStatus;
  children?: ReactNode;
}): JSX.Element {
  const skin = skinFor(status);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium uppercase tracking-label ${skin.pill}`}
    >
      {children ?? skin.label}
    </span>
  );
}

/** §8.4: the one red thing on the screen. */
export function NeedsCheckoutPill({ overdue }: { overdue: string }): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-alert bg-alert px-2.5 py-1 text-[11px] font-semibold uppercase tracking-label text-white">
      <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.4">
        <path d="M12 8v5M12 17h.01" strokeLinecap="round" />
        <circle cx="12" cy="12" r="9" />
      </svg>
      Needs checkout · {overdue}
    </span>
  );
}
