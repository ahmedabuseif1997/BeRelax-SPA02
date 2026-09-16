import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Shift } from '@prisma/client';
import { z } from 'zod';
import {
  ClockShiftDto,
  CreateShiftDto,
  ErrorCode,
  ShiftStatus,
  UpdateShiftDto,
  UserRole,
  businessDay,
} from '@berelax/contracts';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../common/request-context';
import { apiError, businessDayColumn } from '../reservations/reservations.service';

/* ───────────────────────── presentation ───────────────────────── */

export interface ShiftView {
  id: string;
  employeeId: string;
  /** The TRADING day, not the calendar day — a shift ending at 02:00 is the day before. §3.3. */
  businessDay: string;
  plannedStart: string;
  plannedEnd: string;
  clockInAt: string | null;
  clockOutAt: string | null;
  status: ShiftStatus;
  note: string | null;
  employee?: { id: string; displayName: string };
}

type ShiftWithEmployee = Shift & { employee?: { id: string; displayName: string } | null };

/** `displayName` only. A roster is not a place for `legalName`. §6.4. */
const SHIFT_INCLUDE = {
  employee: { select: { id: true, displayName: true } },
} satisfies Prisma.ShiftInclude;

export function presentShift(shift: ShiftWithEmployee): ShiftView {
  const view: ShiftView = {
    id: shift.id,
    employeeId: shift.employeeId,
    businessDay: shift.businessDay.toISOString().slice(0, 10),
    plannedStart: shift.plannedStart.toISOString(),
    plannedEnd: shift.plannedEnd.toISOString(),
    clockInAt: shift.clockInAt?.toISOString() ?? null,
    clockOutAt: shift.clockOutAt?.toISOString() ?? null,
    status: shift.status as ShiftStatus,
    note: shift.note,
  };
  if (shift.employee) view.employee = shift.employee;
  return view;
}

/* ───────────────────────── query contract ───────────────────────── */

export const listShiftsQuerySchema = z.object({
  businessDay: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a trading day in YYYY-MM-DD form.')
    .optional(),
  employeeId: z.string().uuid().optional(),
  status: z.nativeEnum(ShiftStatus).optional(),
});
export type ListShiftsQuery = z.infer<typeof listShiftsQuerySchema>;

/**
 * Take the row lock FIRST, then read the row through Prisma — the same shape as
 * `lockReservation`, and for the same reason: two receptionists tapping Clock in
 * on the same therapist must serialise here rather than race each other to the
 * timestamp. The raw statement exists only for `FOR UPDATE`.
 */
async function lockShift(
  tx: Prisma.TransactionClient,
  id: string,
  branchId: string,
): Promise<Shift> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM shifts
     WHERE id = ${id}::uuid AND branch_id = ${branchId}::uuid
     FOR UPDATE`;

  if (locked.length === 0) {
    throw new NotFoundException(apiError(ErrorCode.NOT_FOUND, 'No such shift in this branch.'));
  }
  return tx.shift.findUniqueOrThrow({ where: { id } });
}

/* ───────────────────────── the service ───────────────────────── */

@Injectable()
export class ShiftsService {
  constructor(private readonly prisma: PrismaService) {}

  /** The roster for one trading day. A THERAPIST sees their own line and no one else's. */
  async findMany(query: ListShiftsQuery, actor: AuthUser): Promise<ShiftView[]> {
    const isTherapist = actor.role === UserRole.THERAPIST;
    const employeeId = isTherapist ? (actor.employeeId ?? null) : (query.employeeId ?? null);
    // A therapist login with no linked employee row has no shifts, not everyone's.
    if (isTherapist && !employeeId) return [];

    const where: Prisma.ShiftWhereInput = {
      branchId: actor.branchId,
      businessDay: businessDayColumn(query.businessDay ?? businessDay(new Date())),
    };
    if (employeeId) where.employeeId = employeeId;
    if (query.status) where.status = query.status;

    const rows = await this.prisma.shift.findMany({
      where,
      include: SHIFT_INCLUDE,
      orderBy: { plannedStart: 'asc' },
    });
    return rows.map(presentShift);
  }

  /**
   * Plan a shift. The trading day is DERIVED from `plannedStart` rather than
   * accepted from the caller: a shift starting at 23:00 belongs to that evening
   * and a shift starting at 01:00 belongs to the evening before, and the one
   * shift per employee per trading day rule only means anything if both are
   * filed the same way. §3.3.
   */
  async plan(dto: CreateShiftDto, actor: AuthUser): Promise<ShiftView> {
    const plannedStart = new Date(dto.plannedStart);
    const plannedEnd = new Date(dto.plannedEnd);
    assertShiftWindow(plannedStart, plannedEnd);

    const employee = await this.prisma.employee.findFirst({
      where: { id: dto.employeeId, branchId: actor.branchId, deletedAt: null },
      select: { id: true },
    });
    if (!employee) {
      throw new NotFoundException(apiError(ErrorCode.NOT_FOUND, 'No such therapist in this branch.'));
    }

    const day = businessDayColumn(plannedStart);
    try {
      const shift = await this.prisma.shift.create({
        data: {
          // From the TOKEN, never the body. §6.6.
          branchId: actor.branchId,
          employeeId: employee.id,
          businessDay: day,
          plannedStart,
          plannedEnd,
          note: dto.note ?? null,
        },
        include: SHIFT_INCLUDE,
      });
      return presentShift(shift);
    } catch (error) {
      throw asAlreadyPlanned(error, employee.id, day);
    }
  }

  /**
   * Moving `plannedStart` can move the trading day with it, so the derived
   * column is recomputed rather than left pointing at the day it was planned on.
   */
  async update(id: string, dto: UpdateShiftDto, actor: AuthUser): Promise<ShiftView> {
    const shift = await this.findInBranch(id, actor.branchId);

    const plannedStart = dto.plannedStart ? new Date(dto.plannedStart) : shift.plannedStart;
    const plannedEnd = dto.plannedEnd ? new Date(dto.plannedEnd) : shift.plannedEnd;
    if (dto.plannedStart || dto.plannedEnd) assertShiftWindow(plannedStart, plannedEnd);

    const day = businessDayColumn(plannedStart);
    try {
      const updated = await this.prisma.shift.update({
        where: { id: shift.id },
        data: {
          ...(dto.plannedStart ? { plannedStart, businessDay: day } : {}),
          ...(dto.plannedEnd ? { plannedEnd } : {}),
          ...(dto.status !== undefined ? { status: dto.status } : {}),
          ...(dto.note !== undefined ? { note: dto.note } : {}),
        },
        include: SHIFT_INCLUDE,
      });
      return presentShift(updated);
    } catch (error) {
      throw asAlreadyPlanned(error, shift.employeeId, day);
    }
  }

  /** The therapist is here. `at` exists for the clock reception forgot to press. */
  async clockIn(id: string, dto: ClockShiftDto, actor: AuthUser): Promise<ShiftView> {
    return this.prisma.$transaction(async (tx) => {
      const shift = await lockShift(tx, id, actor.branchId);

      if (shift.clockInAt) {
        throw new ConflictException(
          apiError(ErrorCode.SHIFT_ALREADY_CLOCKED_IN, 'That shift is already clocked in.', {
            clockInAt: shift.clockInAt.toISOString(),
          }),
        );
      }

      const at = dto.at ? new Date(dto.at) : new Date();
      const updated = await tx.shift.update({
        where: { id: shift.id },
        data: { clockInAt: at, status: ShiftStatus.ACTIVE },
        include: SHIFT_INCLUDE,
      });
      return presentShift(updated);
    });
  }

  /**
   * The therapist has gone home. A clock-out with no clock-in, or one stamped
   * earlier than the clock-in, is a 422 rather than a stored negative shift —
   * attendance feeds utilisation reporting, and a negative hour poisons it.
   */
  async clockOut(id: string, dto: ClockShiftDto, actor: AuthUser): Promise<ShiftView> {
    return this.prisma.$transaction(async (tx) => {
      const shift = await lockShift(tx, id, actor.branchId);

      if (!shift.clockInAt) {
        throw new UnprocessableEntityException(
          apiError(
            ErrorCode.SHIFT_NOT_CLOCKED_IN,
            'That shift was never clocked in, so it cannot be clocked out.',
          ),
        );
      }
      if (shift.clockOutAt) {
        throw new ConflictException(
          apiError(ErrorCode.SHIFT_ALREADY_CLOCKED_OUT, 'That shift is already clocked out.', {
            clockOutAt: shift.clockOutAt.toISOString(),
          }),
        );
      }

      const at = dto.at ? new Date(dto.at) : new Date();
      if (at < shift.clockInAt) {
        throw new UnprocessableEntityException(
          apiError(
            ErrorCode.SHIFT_CLOCK_OUT_BEFORE_CLOCK_IN,
            'A shift cannot end before it started. Check the time.',
            { clockInAt: shift.clockInAt.toISOString(), clockOutAt: at.toISOString() },
          ),
        );
      }

      const updated = await tx.shift.update({
        where: { id: shift.id },
        data: { clockOutAt: at, status: ShiftStatus.ENDED },
        include: SHIFT_INCLUDE,
      });
      return presentShift(updated);
    });
  }

  private async findInBranch(id: string, branchId: string): Promise<Shift> {
    const shift = await this.prisma.shift.findFirst({ where: { id, branchId } });
    if (!shift) {
      throw new NotFoundException(apiError(ErrorCode.NOT_FOUND, 'No such shift in this branch.'));
    }
    return shift;
  }
}

/** Cross-field, so it lives here rather than in a schema refine that would flatten the code. */
function assertShiftWindow(plannedStart: Date, plannedEnd: Date): void {
  if (plannedEnd > plannedStart) return;
  throw new UnprocessableEntityException(
    apiError(ErrorCode.SHIFT_ENDS_BEFORE_START, 'A shift has to end after it starts.', {
      plannedStart: plannedStart.toISOString(),
      plannedEnd: plannedEnd.toISOString(),
    }),
  );
}

/**
 * `shifts_employee_id_business_day_key` is the arbiter of one shift per
 * therapist per trading day — a pre-flight lookup would lose the race between
 * two managers planning the same rota. Caught here so reception reads why
 * instead of "unique constraint failed".
 */
function asAlreadyPlanned(error: unknown, employeeId: string, day: Date): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    return new ConflictException(
      apiError(
        ErrorCode.SHIFT_ALREADY_PLANNED,
        'That therapist already has a shift on this trading day. Edit that one instead.',
        { employeeId, businessDay: day.toISOString().slice(0, 10) },
      ),
    );
  }
  return error;
}
