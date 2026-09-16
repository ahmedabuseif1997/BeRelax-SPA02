import { Injectable, NotFoundException } from '@nestjs/common';
import { ShiftStatus } from '@prisma/client';
import {
  AvailabilityQuery,
  ErrorCode,
  ReservationStatus,
  businessDay,
} from '@berelax/contracts';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../common/request-context';
import { apiError, businessDayColumn } from '../reservations/reservations.service';

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS IS A HINT. IT IS NOT A RESERVATION.
 *
 * Everything below reads committed rows and draws the gaps between them. It
 * holds nothing, promises nothing and is stale the moment it is serialised —
 * by the time the grid has painted on reception's iPad another receptionist,
 * or the website, may already have taken the window it is showing.
 *
 * So: no caller may use this to decide whether an insert is safe, and no code
 * path may skip an insert because a window "looked free". The three exclusion
 * constraints on `reservations` (§5.2) are what actually decides, and a
 * check-then-insert has a race window that WILL double-book on a busy Friday
 * when two people tap Confirm in the same second. Book the slot, let the
 * database reject it, and turn 23P01 into a 409 the receptionist understands.
 * §5.5.
 *
 * The honest reading of this endpoint is: "here is what was free a moment ago,
 * so the desk has somewhere sensible to aim." Nothing more.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Dubai has no daylight saving, so a fixed offset is exact rather than convenient. §3.2. */
const DUBAI_UTC_OFFSET = '+04:00';

/** Used only if a branch row carries nonsense in `opensAt`/`closesAt`. §3.3. */
const DEFAULT_OPENS_AT = '11:00';
const DEFAULT_CLOSES_AT = '02:00';

/** The statuses that actually hold a resource — the same set as the exclusion constraints. §5.2. */
const BLOCKING_STATUSES = [ReservationStatus.SCHEDULED, ReservationStatus.IN_PROGRESS] as const;

export interface AvailabilityWindow {
  startsAt: string;
  endsAt: string;
  /** Length of the treatment that fits here. The turnaround is already excluded. */
  minutes: number;
}

export interface TherapistAvailability {
  employeeId: string;
  displayName: string;
  shift: { startsAt: string; endsAt: string; status: ShiftStatus };
  windows: AvailabilityWindow[];
}

export interface RoomAvailability {
  roomId: string;
  name: string;
  windows: AvailabilityWindow[];
}

export interface AvailabilityView {
  businessDay: string;
  /**
   * When this snapshot was taken. The dashboard greys out windows that have
   * already passed — the server deliberately does not, so the same trading day
   * renders identically whether it is asked for at noon or at midnight.
   */
  generatedAt: string;
  turnaroundMins: number;
  tradingWindow: { opensAt: string; closesAt: string };
  requestedService: { id: string; name: string; durationMinutes: number } | null;
  therapists: TherapistAvailability[];
  rooms: RoomAvailability[];
}

interface Interval {
  start: Date;
  end: Date;
}

@Injectable()
export class AvailabilityService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The free-slot grid for one trading day.
   *
   * Every therapist on shift is answered from ONE reservations query, not one
   * per therapist: an eight-therapist evening would otherwise be nine round
   * trips to draw a screen reception reloads every couple of minutes. The
   * reads are not wrapped in a transaction either — a cross-query snapshot
   * would be false precision on a value that is a hint by construction.
   */
  async find(query: AvailabilityQuery, actor: AuthUser): Promise<AvailabilityView> {
    const day = query.businessDay ?? businessDay(new Date());
    const dayColumn = businessDayColumn(day);
    const branchId = actor.branchId;

    const [branch, shifts, reservations, rooms, service] = await Promise.all([
      this.prisma.branch.findUniqueOrThrow({
        where: { id: branchId },
        select: { turnaroundMins: true, opensAt: true, closesAt: true },
      }),
      this.prisma.shift.findMany({
        where: {
          branchId,
          businessDay: dayColumn,
          // ABSENT is the one status that means "not here": PLANNED, ACTIVE and
          // ENDED all describe a therapist who is on the rota for this day.
          status: { not: ShiftStatus.ABSENT },
          employee: { deletedAt: null },
          ...(query.employeeId ? { employeeId: query.employeeId } : {}),
        },
        select: {
          plannedStart: true,
          plannedEnd: true,
          status: true,
          employee: { select: { id: true, displayName: true } },
        },
      }),
      // The whole day's held bookings, for every therapist and room at once.
      this.prisma.reservation.findMany({
        where: { branchId, businessDay: dayColumn, status: { in: [...BLOCKING_STATUSES] } },
        select: {
          employeeId: true,
          roomId: true,
          startsAt: true,
          blockedUntil: true,
          status: true,
        },
      }),
      this.prisma.room.findMany({
        where: { branchId, isActive: true },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
      query.serviceId
        ? this.prisma.service.findFirst({
            where: { id: query.serviceId, branchId, isActive: true },
            select: { id: true, name: true, durationMinutes: true },
          })
        : Promise.resolve(null),
    ]);

    if (query.serviceId && !service) {
      throw new NotFoundException(
        apiError(ErrorCode.NOT_FOUND, 'That service is not on this branch’s menu.'),
      );
    }

    const turnaroundMins = branch.turnaroundMins;
    const trading = tradingWindow(day, branch.opensAt, branch.closesAt);
    // Nothing shorter than the requested treatment is worth showing: a 20-minute
    // gap is not an opening for a 90-minute massage, it is noise on the screen.
    const minMinutes = service?.durationMinutes ?? 0;

    const byEmployee = groupBusy(reservations, (r) => r.employeeId, turnaroundMins);
    const byRoom = groupBusy(reservations, (r) => r.roomId, turnaroundMins);

    const therapists = shifts
      .map<TherapistAvailability>((shift) => {
        const onShift = intersect(
          { start: shift.plannedStart, end: shift.plannedEnd },
          trading,
        );
        return {
          employeeId: shift.employee.id,
          displayName: shift.employee.displayName,
          shift: {
            startsAt: shift.plannedStart.toISOString(),
            endsAt: shift.plannedEnd.toISOString(),
            status: shift.status,
          },
          windows: onShift
            ? present(freeWindows(onShift, byEmployee.get(shift.employee.id) ?? []), minMinutes)
            : [],
        };
      })
      .sort((a, b) => a.displayName.localeCompare(b.displayName));

    const roomViews = rooms.map<RoomAvailability>((room) => ({
      roomId: room.id,
      name: room.name,
      // A room has no rota: it is available for the whole trading window.
      windows: present(freeWindows(trading, byRoom.get(room.id) ?? []), minMinutes),
    }));

    return {
      businessDay: day,
      generatedAt: new Date().toISOString(),
      turnaroundMins,
      tradingWindow: {
        opensAt: trading.start.toISOString(),
        closesAt: trading.end.toISOString(),
      },
      requestedService: service,
      therapists,
      rooms: roomViews,
    };
  }
}

/* ───────────────────────── interval arithmetic ───────────────────────── */

interface BusySource {
  employeeId: string;
  roomId: string | null;
  startsAt: Date;
  blockedUntil: Date;
  status: string;
}

/**
 * Turn held bookings into the intervals a NEW treatment may not touch, keyed by
 * whatever resource they occupy.
 *
 * The turnaround is applied at BOTH edges, and the two edges are not symmetric
 * in the data:
 *
 *   • After an existing booking, `blocked_until` already carries the turnaround
 *     — the derive trigger writes `ends_at + turnaround` (§5.3), which is the
 *     column the exclusion constraints range over. A new booking may start on
 *     that instant and not a moment before.
 *
 *   • Before an existing booking, the new treatment needs room for its OWN
 *     turnaround, so its body has to finish `turnaround` minutes ahead of the
 *     next `starts_at`. That subtraction is done here.
 *
 * The result is that a free window is expressed in treatment-body time: its
 * length is exactly the longest service that can be dropped into it.
 */
function groupBusy(
  reservations: readonly BusySource[],
  key: (r: BusySource) => string | null,
  turnaroundMins: number,
): Map<string, Interval[]> {
  const turnaroundMs = turnaroundMins * 60_000;
  const out = new Map<string, Interval[]>();

  for (const r of reservations) {
    // Belt and braces with the query's own `status IN (...)` filter, and for the
    // same reason the exclusion constraints carry a partial predicate: a
    // cancelled or no-show booking releases its slot the instant it is recorded,
    // and a grid that kept showing it blocked would cost the spa the rebooking.
    if (!(BLOCKING_STATUSES as readonly string[]).includes(r.status)) continue;

    const id = key(r);
    if (!id) continue;

    const list = out.get(id);
    const interval: Interval = {
      start: new Date(r.startsAt.getTime() - turnaroundMs),
      end: r.blockedUntil,
    };
    if (list) list.push(interval);
    else out.set(id, [interval]);
  }
  return out;
}

/** The overlap of two intervals, or null when they do not touch. */
function intersect(a: Interval, b: Interval): Interval | null {
  const start = a.start > b.start ? a.start : b.start;
  const end = a.end < b.end ? a.end : b.end;
  return end > start ? { start, end } : null;
}

/**
 * The gaps left in `window` once every busy interval is removed. Exported
 * because this, and not the Prisma plumbing around it, is the part that has to
 * be right.
 */
export function freeWindows(window: Interval, busy: readonly Interval[]): Interval[] {
  const blocks = busy
    .map((b) => intersect(b, window))
    .filter((b): b is Interval => b !== null)
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  const free: Interval[] = [];
  let cursor = window.start;

  for (const block of blocks) {
    if (block.start > cursor) free.push({ start: cursor, end: block.start });
    // Overlapping and back-to-back bookings collapse here rather than needing a
    // separate merge pass: the cursor only ever moves forwards.
    if (block.end > cursor) cursor = block.end;
  }
  if (cursor < window.end) free.push({ start: cursor, end: window.end });

  return free;
}

function present(windows: readonly Interval[], minMinutes: number): AvailabilityWindow[] {
  return windows
    .map((w) => ({
      startsAt: w.start.toISOString(),
      endsAt: w.end.toISOString(),
      minutes: Math.floor((w.end.getTime() - w.start.getTime()) / 60_000),
    }))
    .filter((w) => w.minutes > 0 && w.minutes >= minMinutes);
}

/* ─────────────────────────── the trading day ─────────────────────────── */

/**
 * 11:00 to 02:00 the following morning, in Dubai wall-clock time. This is the
 * outer bound on every window: a therapist rostered past closing is still not
 * bookable past closing. §3.3.
 */
export function tradingWindow(day: string, opensAt: string, closesAt: string): Interval {
  const opens = dubaiWallClock(day, opensAt, DEFAULT_OPENS_AT);
  const sameDayClose = dubaiWallClock(day, closesAt, DEFAULT_CLOSES_AT);
  // 02:00 is smaller than 11:00 on a clock face and later than it in real time.
  const closes =
    sameDayClose.getTime() > opens.getTime()
      ? sameDayClose
      : dubaiWallClock(nextCalendarDay(day), closesAt, DEFAULT_CLOSES_AT);
  return { start: opens, end: closes };
}

/** `HH:MM` in Dubai on a given calendar date, as a UTC instant. */
function dubaiWallClock(day: string, hhmm: string, fallback: string): Date {
  const time = /^([01]\d|2[0-3]):([0-5]\d)$/.test(hhmm) ? hhmm : fallback;
  return new Date(`${day}T${time}:00${DUBAI_UTC_OFFSET}`);
}

function nextCalendarDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}
