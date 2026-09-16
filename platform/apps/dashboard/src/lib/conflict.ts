import { ErrorCode } from '@berelax/contracts';
import { ApiError } from './api-client';
import type { ReservationView } from './api-types';
import { dubaiTime, dubaiTimeRange } from './grid-time';

/**
 * "Layla is already booked 14:00–15:00."
 *
 * The database arbitrates double-booking with three exclusion constraints, and
 * `PrismaErrorFilter` turns SQLSTATE 23P01 into a 409 with a readable message —
 * but a generic one: "That therapist already has a booking overlapping this
 * time." It sends no `details`, so it cannot name the clash.
 *
 * The grid already has the day loaded, so the dashboard finds the offending
 * booking itself and says which one it is. When it cannot (the clash is with a
 * booking on an adjacent trading day, or the grid is stale) it falls back to
 * the server's message verbatim — never to a guess.
 */

export interface ConflictDraft {
  employeeId: string;
  roomId?: string | undefined;
  guestId?: string | undefined;
  startsAt: string;
  durationMinutes: number;
}

export interface ConflictExplanation {
  /** Which field the receptionist has to change. */
  field: 'employee' | 'room' | 'guest' | 'time';
  message: string;
  /** The booking in the way, when we found it — so the UI can highlight it. */
  clashingReservationId?: string;
}

const BLOCKING_STATUSES = new Set(['SCHEDULED', 'IN_PROGRESS', 'COMPLETED']);

export function explainConflict(
  error: unknown,
  draft: ConflictDraft,
  dayReservations: readonly ReservationView[],
): ConflictExplanation | null {
  if (!(error instanceof ApiError) || !error.isConflict) return null;

  const draftStart = Date.parse(draft.startsAt);
  const draftEnd = draftStart + draft.durationMinutes * 60_000;

  const overlapping = (match: (r: ReservationView) => boolean): ReservationView | undefined =>
    dayReservations.find((r) => {
      if (!BLOCKING_STATUSES.has(r.status) || !match(r)) return false;
      // The slot is held until `blockedUntil` — endsAt plus the turnaround —
      // which is exactly the range the exclusion constraint uses.
      return Date.parse(r.startsAt) < draftEnd && Date.parse(r.blockedUntil) > draftStart;
    });

  switch (error.code) {
    case ErrorCode.THERAPIST_ALREADY_BOOKED: {
      const clash = overlapping((r) => r.employee?.id === draft.employeeId);
      const who = clash?.employee?.displayName ?? 'That therapist';
      return {
        field: 'employee',
        message: clash ? `${who} is already booked ${clashWindow(clash)}` : error.message,
        ...(clash ? { clashingReservationId: clash.id } : {}),
      };
    }
    case ErrorCode.ROOM_ALREADY_BOOKED: {
      const clash = draft.roomId
        ? overlapping((r) => r.room?.id === draft.roomId)
        : undefined;
      const where = clash?.room?.name ?? 'That room';
      return {
        field: 'room',
        message: clash ? `${where} is in use ${clashWindow(clash)}` : error.message,
        ...(clash ? { clashingReservationId: clash.id } : {}),
      };
    }
    case ErrorCode.GUEST_ALREADY_BOOKED: {
      const clash = draft.guestId
        ? overlapping((r) => r.guest?.id === draft.guestId)
        : undefined;
      const who = clash?.guest?.fullName ?? 'This guest';
      return {
        field: 'guest',
        message: clash
          ? `${who} already has a treatment ${clashWindow(clash)}`
          : error.message,
        ...(clash ? { clashingReservationId: clash.id } : {}),
      };
    }
    case ErrorCode.SLOT_CONFLICT:
      return { field: 'time', message: error.message };
    default:
      return null;
  }
}

/** "14:00–15:00, free again from 15:15." */
function clashWindow(clash: ReservationView): string {
  const range = dubaiTimeRange(clash.startsAt, clash.endsAt);
  const freeAt = Date.parse(clash.blockedUntil);
  const endsAt = Date.parse(clash.endsAt);
  // The turnaround buffer is why a booking that looks free at 15:00 is not.
  const buffer = freeAt > endsAt ? `, free again from ${dubaiTime(clash.blockedUntil)}` : '';
  return `${range}${buffer}.`;
}
