import { HttpException } from '@nestjs/common';
import type { ApiErrorBody } from '@berelax/contracts';
import { UserRole } from '@berelax/contracts';
import type { AuthUser } from '../common/request-context';
import type { PrismaService } from '../prisma/prisma.service';
import { AvailabilityService, freeWindows, tradingWindow } from './availability.service';

const BRANCH_ID = '0192bbbb-0000-7000-8000-00000000000b';
const EMPLOYEE_ID = '0192cccc-0000-7000-8000-00000000000c';
const OTHER_EMPLOYEE_ID = '0192cccc-0000-7000-8000-00000000000f';
const THIRD_EMPLOYEE_ID = '0192cccc-0000-7000-8000-000000000011';
const ROOM_ID = '0192ffff-0000-7000-8000-00000000000f';
const SERVICE_ID = '0192eeee-0000-7000-8000-00000000000e';
const USER_ID = '0192dddd-0000-7000-8000-00000000000d';

const DAY = '2026-09-16';
/** The trading day runs 11:00 Dubai to 02:00 Dubai, i.e. 07:00Z to 22:00Z. §3.3. */
const OPENS = new Date('2026-09-16T11:00:00+04:00');
const CLOSES = new Date('2026-09-17T02:00:00+04:00');

/** Dubai wall-clock on the trading day, as the instant the database stores. */
function at(hhmm: string, nextDay = false): Date {
  return new Date(`2026-09-${nextDay ? '17' : '16'}T${hhmm}:00+04:00`);
}

interface BookingFixture {
  employeeId?: string;
  roomId?: string | null;
  /** Dubai wall-clock, e.g. '19:00'. */
  from: string;
  /** Dubai wall-clock end of the TREATMENT; the turnaround is added here. */
  to: string;
  status?: string;
  nextDay?: boolean;
}

function booking(b: BookingFixture, turnaroundMins = 15) {
  const endsAt = at(b.to, b.nextDay);
  return {
    employeeId: b.employeeId ?? EMPLOYEE_ID,
    roomId: b.roomId === undefined ? null : b.roomId,
    startsAt: at(b.from, b.nextDay),
    // Exactly what trg_reservations_derive writes: ends_at + the branch turnaround. §5.3.
    blockedUntil: new Date(endsAt.getTime() + turnaroundMins * 60_000),
    status: b.status ?? 'SCHEDULED',
  };
}

function shiftOf(employeeId: string, displayName: string, from = '11:00', to = '02:00') {
  return {
    plannedStart: at(from),
    plannedEnd: to === '02:00' ? CLOSES : at(to),
    status: 'PLANNED' as const,
    employee: { id: employeeId, displayName },
  };
}

function actorFixture(role: UserRole = UserRole.RECEPTIONIST): AuthUser {
  return {
    id: USER_ID,
    role,
    branchId: BRANCH_ID,
    employeeId: null,
    email: 'reception@berelax.ae',
    fullName: 'Reception',
  };
}

function setup(
  options: {
    turnaroundMins?: number;
    shifts?: ReturnType<typeof shiftOf>[];
    reservations?: ReturnType<typeof booking>[];
    rooms?: { id: string; name: string }[];
    service?: { id: string; name: string; durationMinutes: number } | null;
  } = {},
) {
  const prisma = {
    branch: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        turnaroundMins: options.turnaroundMins ?? 15,
        opensAt: '11:00',
        closesAt: '02:00',
      }),
    },
    shift: {
      findMany: jest.fn().mockResolvedValue(options.shifts ?? [shiftOf(EMPLOYEE_ID, 'Layla')]),
    },
    reservation: { findMany: jest.fn().mockResolvedValue(options.reservations ?? []) },
    room: { findMany: jest.fn().mockResolvedValue(options.rooms ?? []) },
    service: {
      findFirst: jest.fn().mockResolvedValue(
        options.service === undefined
          ? { id: SERVICE_ID, name: 'Balinese Massage — 90 min', durationMinutes: 90 }
          : options.service,
      ),
    },
  } as unknown as PrismaService;

  return { prisma, service: new AvailabilityService(prisma) };
}

async function caught(run: () => Promise<unknown>): Promise<{ status: number; body: ApiErrorBody }> {
  try {
    await run();
  } catch (err) {
    const http = err as HttpException;
    return { status: http.getStatus(), body: http.getResponse() as ApiErrorBody };
  }
  throw new Error('expected the call to reject, but it resolved');
}

describe('AvailabilityService', () => {
  describe('the grid is a hint, not a reservation', () => {
    it('reads only, and never writes anything that could be mistaken for a hold', async () => {
      // If this endpoint ever grows a write it has stopped being a hint. §5.5.
      const { service, prisma } = setup();
      const client = prisma as unknown as Record<string, Record<string, unknown>>;

      await service.find({ businessDay: DAY }, actorFixture());

      for (const model of ['reservation', 'shift', 'room']) {
        expect(client[model]!.create).toBeUndefined();
        expect(client[model]!.update).toBeUndefined();
      }
    });

    it('stamps the moment it was taken, because it is stale immediately', async () => {
      const { service } = setup();

      const view = await service.find({ businessDay: DAY }, actorFixture());

      expect(Date.parse(view.generatedAt)).not.toBeNaN();
    });
  });

  describe('free windows', () => {
    it('offers a therapist with no bookings their whole shift', async () => {
      const { service } = setup();

      const view = await service.find({ businessDay: DAY }, actorFixture());

      expect(view.therapists).toHaveLength(1);
      expect(view.therapists[0]!.windows).toEqual([
        {
          startsAt: OPENS.toISOString(),
          endsAt: CLOSES.toISOString(),
          // 11:00 to 02:00 is fifteen hours.
          minutes: 900,
        },
      ]);
    });

    it('splits the shift in two around one booking, with the turnaround at both edges', async () => {
      // A 19:00-20:00 treatment on a branch with a 15-minute turnaround:
      //   • nothing may END after 18:45, or its own turnaround would run into 19:00
      //   • nothing may START before 20:15, which is the booking's blocked_until
      const { service } = setup({ reservations: [booking({ from: '19:00', to: '20:00' })] });

      const view = await service.find({ businessDay: DAY }, actorFixture());

      expect(view.therapists[0]!.windows).toEqual([
        { startsAt: OPENS.toISOString(), endsAt: at('18:45').toISOString(), minutes: 465 },
        { startsAt: at('20:15').toISOString(), endsAt: CLOSES.toISOString(), minutes: 345 },
      ]);
    });

    it('does not offer a gap shorter than the requested treatment', async () => {
      // 12:15 (blocked_until) to 12:45 (13:00 less the turnaround) is thirty
      // minutes. That is not an opening for a ninety-minute massage.
      const { service } = setup({
        reservations: [
          booking({ from: '11:00', to: '12:00' }),
          booking({ from: '13:00', to: '14:00' }),
        ],
        service: { id: SERVICE_ID, name: 'Balinese Massage — 90 min', durationMinutes: 90 },
      });

      const view = await service.find({ businessDay: DAY, serviceId: SERVICE_ID }, actorFixture());

      expect(view.therapists[0]!.windows).toEqual([
        { startsAt: at('14:15').toISOString(), endsAt: CLOSES.toISOString(), minutes: 705 },
      ]);
      expect(view.requestedService).toEqual({
        id: SERVICE_ID,
        name: 'Balinese Massage — 90 min',
        durationMinutes: 90,
      });
    });

    it('shows the same short gap once a shorter treatment is asked for', async () => {
      const { service } = setup({
        reservations: [
          booking({ from: '11:00', to: '12:00' }),
          booking({ from: '13:00', to: '14:00' }),
        ],
        service: { id: SERVICE_ID, name: 'Foot Reflexology — 30 min', durationMinutes: 30 },
      });

      const view = await service.find({ businessDay: DAY, serviceId: SERVICE_ID }, actorFixture());

      expect(view.therapists[0]!.windows[0]).toEqual({
        startsAt: at('12:15').toISOString(),
        endsAt: at('12:45').toISOString(),
        minutes: 30,
      });
    });

    it('does not let a cancelled booking block the slot it released', async () => {
      // The exclusion constraints skip cancelled rows (§5.2) and so does this:
      // a grid that kept showing a cancellation blocked would cost the rebooking.
      const { service, prisma } = setup({
        reservations: [booking({ from: '19:00', to: '20:00', status: 'CANCELLED' })],
      });

      const view = await service.find({ businessDay: DAY }, actorFixture());

      expect(view.therapists[0]!.windows).toHaveLength(1);
      expect(view.therapists[0]!.windows[0]!.minutes).toBe(900);
      // ...and the query never asked for one in the first place.
      const { where } = (prisma.reservation.findMany as jest.Mock).mock.calls[0]![0] as {
        where: { status: { in: string[] } };
      };
      expect(where.status.in).toEqual(['SCHEDULED', 'IN_PROGRESS']);
    });

    it('treats an in-progress treatment as holding its slot', async () => {
      const { service } = setup({
        reservations: [booking({ from: '19:00', to: '20:00', status: 'IN_PROGRESS' })],
      });

      const view = await service.find({ businessDay: DAY }, actorFixture());

      expect(view.therapists[0]!.windows).toHaveLength(2);
    });

    it('collapses back-to-back bookings into one block rather than a zero-length gap', async () => {
      const { service } = setup({
        reservations: [
          booking({ from: '19:00', to: '20:00' }),
          booking({ from: '20:15', to: '21:15' }),
        ],
      });

      const view = await service.find({ businessDay: DAY }, actorFixture());

      expect(view.therapists[0]!.windows).toEqual([
        { startsAt: OPENS.toISOString(), endsAt: at('18:45').toISOString(), minutes: 465 },
        { startsAt: at('21:30').toISOString(), endsAt: CLOSES.toISOString(), minutes: 270 },
      ]);
    });

    it('clamps a shift that runs past closing to the trading window', async () => {
      // A rota mistake must not make a therapist bookable at 04:00.
      const { service } = setup({
        shifts: [
          {
            plannedStart: at('11:00'),
            plannedEnd: at('06:00', true),
            status: 'PLANNED' as const,
            employee: { id: EMPLOYEE_ID, displayName: 'Layla' },
          },
        ],
      });

      const view = await service.find({ businessDay: DAY }, actorFixture());

      expect(view.therapists[0]!.windows[0]!.endsAt).toBe(CLOSES.toISOString());
      // The raw rota is still reported, so the discrepancy is visible.
      expect(view.therapists[0]!.shift.endsAt).toBe(at('06:00', true).toISOString());
    });

    it('offers nothing for a shift that falls entirely outside trading hours', async () => {
      const { service } = setup({
        shifts: [
          {
            plannedStart: at('03:00', true),
            plannedEnd: at('05:00', true),
            status: 'PLANNED' as const,
            employee: { id: EMPLOYEE_ID, displayName: 'Layla' },
          },
        ],
      });

      const view = await service.find({ businessDay: DAY }, actorFixture());

      expect(view.therapists[0]!.windows).toEqual([]);
    });

    it('honours a branch with no turnaround at all', async () => {
      const { service } = setup({
        turnaroundMins: 0,
        reservations: [booking({ from: '19:00', to: '20:00' }, 0)],
      });

      const view = await service.find({ businessDay: DAY }, actorFixture());

      expect(view.therapists[0]!.windows).toEqual([
        { startsAt: OPENS.toISOString(), endsAt: at('19:00').toISOString(), minutes: 480 },
        { startsAt: at('20:00').toISOString(), endsAt: CLOSES.toISOString(), minutes: 360 },
      ]);
    });
  });

  describe('rooms', () => {
    it('reports free room windows from the same booking set', async () => {
      const { service } = setup({
        rooms: [{ id: ROOM_ID, name: 'Room 1' }],
        reservations: [booking({ from: '19:00', to: '20:00', roomId: ROOM_ID })],
      });

      const view = await service.find({ businessDay: DAY }, actorFixture());

      expect(view.rooms).toHaveLength(1);
      expect(view.rooms[0]!.windows).toEqual([
        { startsAt: OPENS.toISOString(), endsAt: at('18:45').toISOString(), minutes: 465 },
        { startsAt: at('20:15').toISOString(), endsAt: CLOSES.toISOString(), minutes: 345 },
      ]);
    });

    it('leaves a room free when the booking that day needed no room', async () => {
      // `room_id IS NULL` rows never conflict — the constraint skips them too. §5.2.
      const { service } = setup({
        rooms: [{ id: ROOM_ID, name: 'Room 1' }],
        reservations: [booking({ from: '19:00', to: '20:00', roomId: null })],
      });

      const view = await service.find({ businessDay: DAY }, actorFixture());

      expect(view.rooms[0]!.windows).toHaveLength(1);
    });
  });

  describe('the queries it makes', () => {
    it('answers every therapist from one reservations query, not one each', async () => {
      const { service, prisma } = setup({
        shifts: [
          shiftOf(EMPLOYEE_ID, 'Layla'),
          shiftOf(OTHER_EMPLOYEE_ID, 'Maya'),
          shiftOf(THIRD_EMPLOYEE_ID, 'Aisha'),
        ],
        reservations: [
          booking({ from: '19:00', to: '20:00' }),
          booking({ from: '15:00', to: '16:00', employeeId: OTHER_EMPLOYEE_ID }),
        ],
      });

      const view = await service.find({ businessDay: DAY }, actorFixture());

      expect(prisma.reservation.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.shift.findMany).toHaveBeenCalledTimes(1);
      // Sorted by the name reception reads off the screen.
      expect(view.therapists.map((t) => t.displayName)).toEqual(['Aisha', 'Layla', 'Maya']);
      expect(view.therapists[0]!.windows).toHaveLength(1);
      expect(view.therapists[1]!.windows).toHaveLength(2);
      expect(view.therapists[2]!.windows).toHaveLength(2);
    });

    it('scopes every read to the branch on the token, never a branch in the query', async () => {
      const { service, prisma } = setup();

      await service.find({ businessDay: DAY }, actorFixture());

      for (const call of [
        (prisma.shift.findMany as jest.Mock).mock.calls[0]![0],
        (prisma.reservation.findMany as jest.Mock).mock.calls[0]![0],
        (prisma.room.findMany as jest.Mock).mock.calls[0]![0],
      ] as { where: { branchId: string } }[]) {
        expect(call.where.branchId).toBe(BRANCH_ID);
      }
    });

    it('does not go looking for a service when none was asked for', async () => {
      const { service, prisma } = setup();

      await service.find({ businessDay: DAY }, actorFixture());

      expect(prisma.service.findFirst).not.toHaveBeenCalled();
    });

    it('404s on a service that is not on this branch’s menu', async () => {
      const { service } = setup({ service: null });

      const { status } = await caught(() =>
        service.find({ businessDay: DAY, serviceId: SERVICE_ID }, actorFixture()),
      );

      expect(status).toBe(404);
    });

    it('narrows the rota query when one therapist is asked for', async () => {
      const { service, prisma } = setup();

      await service.find({ businessDay: DAY, employeeId: EMPLOYEE_ID }, actorFixture());

      const { where } = (prisma.shift.findMany as jest.Mock).mock.calls[0]![0] as {
        where: { employeeId?: string; status: { not: string } };
      };
      expect(where.employeeId).toBe(EMPLOYEE_ID);
      // A therapist marked absent is not on the floor, whatever the rota said.
      expect(where.status).toEqual({ not: 'ABSENT' });
    });

    it('defaults to today’s trading day', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-09-17T01:30:00+04:00'));
      try {
        const { service, prisma } = setup();

        const view = await service.find({}, actorFixture(UserRole.THERAPIST));

        // 01:30 on the 17th is still the 16th's trading day. §3.3.
        expect(view.businessDay).toBe('2026-09-16');
        const { where } = (prisma.shift.findMany as jest.Mock).mock.calls[0]![0] as {
          where: { businessDay: Date };
        };
        expect(where.businessDay).toEqual(new Date('2026-09-16T00:00:00.000Z'));
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('tradingWindow', () => {
    it('runs 11:00 through to 02:00 the following morning', () => {
      const window = tradingWindow(DAY, '11:00', '02:00');

      expect(window.start).toEqual(OPENS);
      expect(window.end).toEqual(CLOSES);
    });

    it('falls back to the spec’s hours if the branch row is malformed', () => {
      const window = tradingWindow(DAY, 'whenever', '25:00');

      expect(window.start).toEqual(OPENS);
      expect(window.end).toEqual(CLOSES);
    });

    it('does not roll over for a branch that closes the same day', () => {
      const window = tradingWindow(DAY, '09:00', '18:00');

      expect(window.end).toEqual(at('18:00'));
    });
  });

  describe('freeWindows', () => {
    const window = { start: OPENS, end: CLOSES };

    it('returns the whole window when nothing is busy', () => {
      expect(freeWindows(window, [])).toEqual([window]);
    });

    it('drops busy intervals that do not touch the window', () => {
      const busy = [{ start: at('04:00'), end: at('05:00') }];

      expect(freeWindows(window, busy)).toEqual([window]);
    });

    it('returns nothing when the window is completely covered', () => {
      const busy = [{ start: at('09:00'), end: at('04:00', true) }];

      expect(freeWindows(window, busy)).toEqual([]);
    });

    it('handles busy intervals arriving out of order and overlapping', () => {
      const busy = [
        { start: at('20:00'), end: at('21:00') },
        { start: at('19:00'), end: at('20:30') },
      ];

      expect(freeWindows(window, busy)).toEqual([
        { start: OPENS, end: at('19:00') },
        { start: at('21:00'), end: CLOSES },
      ]);
    });
  });
});
