import { HttpException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Shift } from '@prisma/client';
import type { ApiErrorBody } from '@berelax/contracts';
import { ErrorCode, ShiftStatus, UserRole } from '@berelax/contracts';
import type { AuthUser } from '../common/request-context';
import type { PrismaService } from '../prisma/prisma.service';
import { ShiftsService } from './shifts.service';

const SHIFT_ID = '0192f8a1-0000-7000-8000-000000000041';
const BRANCH_ID = '0192bbbb-0000-7000-8000-00000000000b';
const EMPLOYEE_ID = '0192cccc-0000-7000-8000-00000000000c';
const OTHER_EMPLOYEE_ID = '0192cccc-0000-7000-8000-00000000000f';
const USER_ID = '0192dddd-0000-7000-8000-00000000000d';

function shiftFixture(overrides: Partial<Shift> = {}): Shift {
  return {
    id: SHIFT_ID,
    branchId: BRANCH_ID,
    employeeId: EMPLOYEE_ID,
    businessDay: new Date('2026-09-16T00:00:00.000Z'),
    plannedStart: new Date('2026-09-16T15:00:00+04:00'),
    plannedEnd: new Date('2026-09-17T01:00:00+04:00'),
    clockInAt: null,
    clockOutAt: null,
    status: 'PLANNED',
    note: null,
    ...overrides,
  };
}

function actorFixture(role: UserRole = UserRole.MANAGER, employeeId?: string): AuthUser {
  return {
    id: USER_ID,
    role,
    branchId: BRANCH_ID,
    employeeId: employeeId ?? null,
    email: 'manager@berelax.ae',
    fullName: 'Manager',
  };
}

type Tx = {
  $queryRaw: jest.Mock;
  shift: {
    findMany: jest.Mock;
    findFirst: jest.Mock;
    findUniqueOrThrow: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
  employee: { findFirst: jest.Mock };
};

function setup(
  options: {
    shift?: Shift;
    /** What the FOR UPDATE lock finds. */
    found?: boolean;
    employeeMissing?: boolean;
  } = {},
) {
  const shift = options.shift ?? shiftFixture();

  const tx: Tx = {
    $queryRaw: jest.fn(async () => (options.found === false ? [] : [{ id: shift.id }])),
    shift: {
      findMany: jest.fn().mockResolvedValue([
        { ...shift, employee: { id: EMPLOYEE_ID, displayName: 'Layla' } },
      ]),
      findFirst: jest.fn().mockResolvedValue(options.found === false ? null : shift),
      findUniqueOrThrow: jest.fn().mockResolvedValue(shift),
      create: jest.fn(async ({ data }: { data: Shift }) => shiftFixture(data)),
      update: jest.fn(async ({ data }: { data: Partial<Shift> }) =>
        shiftFixture({ ...shift, ...data }),
      ),
    },
    employee: {
      findFirst: jest
        .fn()
        .mockResolvedValue(options.employeeMissing ? null : { id: EMPLOYEE_ID }),
    },
  };

  const prisma = {
    $transaction: jest.fn(async (cb: (client: Tx) => Promise<unknown>) => cb(tx)),
    shift: tx.shift,
    employee: tx.employee,
  } as unknown as PrismaService;

  return { tx, service: new ShiftsService(prisma) };
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

function planDto(overrides: Partial<{ plannedStart: string; plannedEnd: string }> = {}) {
  return {
    employeeId: EMPLOYEE_ID,
    plannedStart: '2026-09-16T15:00:00+04:00',
    plannedEnd: '2026-09-17T01:00:00+04:00',
    ...overrides,
  };
}

describe('ShiftsService', () => {
  describe('plan — the trading day is derived, never accepted', () => {
    it('files a shift that runs past midnight under the evening it started', async () => {
      const { service, tx } = setup();

      await service.plan(planDto(), actorFixture());

      const { data } = tx.shift.create.mock.calls[0]![0] as { data: Shift };
      // 15:00 Dubai on the 16th, ending 01:00 on the 17th — all one trading day. §3.3.
      expect(data.businessDay).toEqual(new Date('2026-09-16T00:00:00.000Z'));
      expect(data.branchId).toBe(BRANCH_ID);
    });

    it('files a shift that begins after midnight under the day before', async () => {
      const { service, tx } = setup();

      await service.plan(
        planDto({
          plannedStart: '2026-09-17T01:00:00+04:00',
          plannedEnd: '2026-09-17T02:00:00+04:00',
        }),
        actorFixture(),
      );

      const { data } = tx.shift.create.mock.calls[0]![0] as { data: Shift };
      expect(data.businessDay).toEqual(new Date('2026-09-16T00:00:00.000Z'));
    });

    it('takes branchId from the token, never from the body', async () => {
      const { service, tx } = setup();

      await service.plan(
        { ...planDto(), branchId: 'not-this-one' } as never,
        actorFixture(),
      );

      const { data } = tx.shift.create.mock.calls[0]![0] as { data: Shift };
      expect(data.branchId).toBe(BRANCH_ID);
    });

    it('422s a shift that ends before it starts, before touching the database', async () => {
      const { service, tx } = setup();

      const { status, body } = await caught(() =>
        service.plan(
          planDto({
            plannedStart: '2026-09-16T20:00:00+04:00',
            plannedEnd: '2026-09-16T15:00:00+04:00',
          }),
          actorFixture(),
        ),
      );

      expect(status).toBe(422);
      expect(body.error.code).toBe(ErrorCode.SHIFT_ENDS_BEFORE_START);
      expect(tx.shift.create).not.toHaveBeenCalled();
    });

    it('422s a zero-length shift', async () => {
      const { service } = setup();

      const { status } = await caught(() =>
        service.plan(
          planDto({
            plannedStart: '2026-09-16T15:00:00+04:00',
            plannedEnd: '2026-09-16T15:00:00+04:00',
          }),
          actorFixture(),
        ),
      );

      expect(status).toBe(422);
    });

    it('404s on a therapist who does not work at this branch', async () => {
      const { service, tx } = setup({ employeeMissing: true });

      const { status } = await caught(() => service.plan(planDto(), actorFixture()));

      expect(status).toBe(404);
      expect(tx.shift.create).not.toHaveBeenCalled();
    });

    it('turns the one-per-day unique violation into a readable 409', async () => {
      const { service, tx } = setup();
      tx.shift.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError(
          'Unique constraint failed on the fields: (`employee_id`,`business_day`)',
          { code: 'P2002', clientVersion: '5.22.0' },
        ),
      );

      const { status, body } = await caught(() => service.plan(planDto(), actorFixture()));

      expect(status).toBe(409);
      expect(body.error.code).toBe(ErrorCode.SHIFT_ALREADY_PLANNED);
      expect(body.error.message).toMatch(/already has a shift/i);
      expect(body.error.details).toEqual({
        employeeId: EMPLOYEE_ID,
        businessDay: '2026-09-16',
      });
    });
  });

  describe('update', () => {
    it('recomputes the trading day when the shift is moved to another evening', async () => {
      const { service, tx } = setup();

      await service.update(
        SHIFT_ID,
        { plannedStart: '2026-09-17T15:00:00+04:00', plannedEnd: '2026-09-18T01:00:00+04:00' },
        actorFixture(),
      );

      const { data } = tx.shift.update.mock.calls[0]![0] as { data: Partial<Shift> };
      expect(data.businessDay).toEqual(new Date('2026-09-17T00:00:00.000Z'));
    });

    it('422s if the edit would leave the shift ending before it starts', async () => {
      const { service, tx } = setup();

      const { status, body } = await caught(() =>
        service.update(SHIFT_ID, { plannedEnd: '2026-09-16T14:00:00+04:00' }, actorFixture()),
      );

      expect(status).toBe(422);
      expect(body.error.code).toBe(ErrorCode.SHIFT_ENDS_BEFORE_START);
      expect(tx.shift.update).not.toHaveBeenCalled();
    });

    it('marks a no-show therapist ABSENT without inventing a clock-in', async () => {
      const { service, tx } = setup();

      const view = await service.update(SHIFT_ID, { status: ShiftStatus.ABSENT }, actorFixture());

      const { data } = tx.shift.update.mock.calls[0]![0] as { data: Partial<Shift> };
      expect(data).toEqual({ status: 'ABSENT' });
      expect(view.clockInAt).toBeNull();
    });

    it('404s on a shift from another branch', async () => {
      const { service } = setup({ found: false });

      const { status } = await caught(() =>
        service.update(SHIFT_ID, { note: 'covering reception' }, actorFixture()),
      );

      expect(status).toBe(404);
    });
  });

  describe('clock-in', () => {
    it('stamps the time and turns the shift ACTIVE', async () => {
      const { service, tx } = setup();

      const view = await service.clockIn(
        SHIFT_ID,
        { at: '2026-09-16T15:04:00+04:00' },
        actorFixture(UserRole.RECEPTIONIST),
      );

      const { data } = tx.shift.update.mock.calls[0]![0] as { data: Partial<Shift> };
      expect(data.clockInAt).toEqual(new Date('2026-09-16T15:04:00+04:00'));
      expect(data.status).toBe('ACTIVE');
      expect(view.status).toBe('ACTIVE');
    });

    it('takes the row lock before reading the shift', async () => {
      const { service, tx } = setup();

      await service.clockIn(SHIFT_ID, {}, actorFixture(UserRole.RECEPTIONIST));

      // Two receptionists tapping Clock in must serialise here, not race.
      expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
      expect(tx.shift.findUniqueOrThrow).toHaveBeenCalledTimes(1);
    });

    it('defaults to now when no time is given', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-09-16T15:07:00+04:00'));
      try {
        const { service, tx } = setup();

        await service.clockIn(SHIFT_ID, {}, actorFixture(UserRole.RECEPTIONIST));

        const { data } = tx.shift.update.mock.calls[0]![0] as { data: Partial<Shift> };
        expect(data.clockInAt).toEqual(new Date('2026-09-16T15:07:00+04:00'));
      } finally {
        jest.useRealTimers();
      }
    });

    it('409s a second clock-in rather than overwriting the first', async () => {
      const { service, tx } = setup({
        shift: shiftFixture({
          clockInAt: new Date('2026-09-16T15:04:00+04:00'),
          status: 'ACTIVE',
        }),
      });

      const { status, body } = await caught(() =>
        service.clockIn(SHIFT_ID, {}, actorFixture(UserRole.RECEPTIONIST)),
      );

      expect(status).toBe(409);
      expect(body.error.code).toBe(ErrorCode.SHIFT_ALREADY_CLOCKED_IN);
      expect(tx.shift.update).not.toHaveBeenCalled();
    });

    it('404s on a shift from another branch', async () => {
      const { service } = setup({ found: false });

      const { status, body } = await caught(() =>
        service.clockIn(SHIFT_ID, {}, actorFixture(UserRole.RECEPTIONIST)),
      );

      expect(status).toBe(404);
      expect(body.error.code).toBe(ErrorCode.NOT_FOUND);
    });
  });

  describe('clock-out', () => {
    it('stamps the time and ends the shift', async () => {
      const { service, tx } = setup({
        shift: shiftFixture({ clockInAt: new Date('2026-09-16T15:04:00+04:00'), status: 'ACTIVE' }),
      });

      const view = await service.clockOut(
        SHIFT_ID,
        { at: '2026-09-17T01:10:00+04:00' },
        actorFixture(UserRole.RECEPTIONIST),
      );

      const { data } = tx.shift.update.mock.calls[0]![0] as { data: Partial<Shift> };
      expect(data.clockOutAt).toEqual(new Date('2026-09-17T01:10:00+04:00'));
      expect(data.status).toBe('ENDED');
      expect(view.status).toBe('ENDED');
      // Still the evening it started: the trading day does not move at midnight. §3.3.
      expect(view.businessDay).toBe('2026-09-16');
    });

    it('422s a clock-out on a shift that was never clocked in', async () => {
      const { service, tx } = setup();

      const { status, body } = await caught(() =>
        service.clockOut(SHIFT_ID, {}, actorFixture(UserRole.RECEPTIONIST)),
      );

      expect(status).toBe(422);
      expect(body.error.code).toBe(ErrorCode.SHIFT_NOT_CLOCKED_IN);
      expect(tx.shift.update).not.toHaveBeenCalled();
    });

    it('422s a clock-out stamped earlier than the clock-in', async () => {
      const { service, tx } = setup({
        shift: shiftFixture({ clockInAt: new Date('2026-09-16T15:04:00+04:00'), status: 'ACTIVE' }),
      });

      const { status, body } = await caught(() =>
        service.clockOut(
          SHIFT_ID,
          { at: '2026-09-16T14:00:00+04:00' },
          actorFixture(UserRole.RECEPTIONIST),
        ),
      );

      expect(status).toBe(422);
      expect(body.error.code).toBe(ErrorCode.SHIFT_CLOCK_OUT_BEFORE_CLOCK_IN);
      expect(body.error.details).toMatchObject({
        clockInAt: new Date('2026-09-16T15:04:00+04:00').toISOString(),
      });
      expect(tx.shift.update).not.toHaveBeenCalled();
    });

    it('409s a second clock-out rather than overwriting the first', async () => {
      const { service } = setup({
        shift: shiftFixture({
          clockInAt: new Date('2026-09-16T15:04:00+04:00'),
          clockOutAt: new Date('2026-09-17T01:10:00+04:00'),
          status: 'ENDED',
        }),
      });

      const { status, body } = await caught(() =>
        service.clockOut(SHIFT_ID, {}, actorFixture(UserRole.RECEPTIONIST)),
      );

      expect(status).toBe(409);
      expect(body.error.code).toBe(ErrorCode.SHIFT_ALREADY_CLOCKED_OUT);
    });
  });

  describe('findMany — the roster', () => {
    it('defaults to today’s trading day', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-09-17T01:30:00+04:00'));
      try {
        const { service, tx } = setup();

        await service.findMany({}, actorFixture());

        const { where } = tx.shift.findMany.mock.calls[0]![0] as {
          where: Record<string, unknown>;
        };
        // 01:30 on the 17th still belongs to the 16th's trading day. §3.3.
        expect(where.businessDay).toEqual(new Date('2026-09-16T00:00:00.000Z'));
        expect(where.branchId).toBe(BRANCH_ID);
      } finally {
        jest.useRealTimers();
      }
    });

    it('narrows a THERAPIST to their own line, whatever they ask for', async () => {
      const { service, tx } = setup();

      await service.findMany(
        { employeeId: OTHER_EMPLOYEE_ID },
        actorFixture(UserRole.THERAPIST, EMPLOYEE_ID),
      );

      const { where } = tx.shift.findMany.mock.calls[0]![0] as { where: { employeeId: string } };
      expect(where.employeeId).toBe(EMPLOYEE_ID);
    });

    it('shows a therapist login with no linked employee nothing, not everyone', async () => {
      const { service, tx } = setup();

      const rows = await service.findMany({}, actorFixture(UserRole.THERAPIST));

      expect(rows).toEqual([]);
      expect(tx.shift.findMany).not.toHaveBeenCalled();
    });

    it('carries the therapist’s display name and asks the database for nothing else', async () => {
      const { service, tx } = setup();

      const [row] = await service.findMany({ businessDay: '2026-09-16' }, actorFixture());

      expect(row!.employee).toEqual({ id: EMPLOYEE_ID, displayName: 'Layla' });
      // A roster is not a place for `legalName`, so it is not even selected. §6.4.
      const { include } = tx.shift.findMany.mock.calls[0]![0] as {
        include: { employee: { select: Record<string, boolean> } };
      };
      expect(include.employee.select).toEqual({ id: true, displayName: true });
    });
  });
});
