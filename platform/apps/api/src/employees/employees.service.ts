import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Employee } from '@prisma/client';
import { z } from 'zod';
import {
  CreateEmployeeDto,
  EmployeeStatus,
  ErrorCode,
  ReservationStatus,
  UpdateEmployeeCommissionDto,
  UpdateEmployeeDto,
  UpdateEmployeeStatusDto,
} from '@berelax/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { AuditAction, AuditService, pickAuditFields } from '../common/audit.service';
import type { AuthUser, RequestContext } from '../common/request-context';
import { apiError, isManagerOrAbove } from '../reservations/reservations.service';

/* ───────────────────────── presentation ───────────────────────── */

/**
 * `legalName` is absent from the type unless the caller is allowed it, so a
 * client cannot tell "not recorded" from "not yours to see" — and a future
 * endpoint cannot leak it by forgetting to null it out. §6.4.
 */
export interface EmployeeView {
  id: string;
  displayName: string;
  phone: string | null;
  status: EmployeeStatus;
  commissionBps: number;
  hiredOn: string | null;
  photoUrl: string | null;
  createdAt: string;
  updatedAt: string;
  legalName?: string | null;
}

/** OWNER and MANAGER see every legal name; a THERAPIST sees exactly one — their own. §6.4. */
export function canSeeLegalName(employeeId: string, actor: AuthUser): boolean {
  return isManagerOrAbove(actor.role) || actor.employeeId === employeeId;
}

/** The ONLY way an employee row leaves this module. Every path goes through it. */
export function presentEmployee(employee: Employee, actor: AuthUser): EmployeeView {
  const view: EmployeeView = {
    id: employee.id,
    displayName: employee.displayName,
    phone: employee.phone,
    status: employee.status as EmployeeStatus,
    commissionBps: employee.commissionBps,
    hiredOn: employee.hiredOn ? employee.hiredOn.toISOString().slice(0, 10) : null,
    photoUrl: employee.photoUrl,
    createdAt: employee.createdAt.toISOString(),
    updatedAt: employee.updatedAt.toISOString(),
  };
  if (canSeeLegalName(employee.id, actor)) view.legalName = employee.legalName;
  return view;
}

/* ───────────────────────── query contract ───────────────────────── */

export const listEmployeesQuerySchema = z.object({
  status: z.nativeEnum(EmployeeStatus).optional(),
});
export type ListEmployeesQuery = z.infer<typeof listEmployeesQuerySchema>;

/** `@db.Date` stores UTC midnight; Prisma rejects a bare `YYYY-MM-DD` on a DateTime field. */
function dateColumn(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/* ───────────────────────── the service ───────────────────────── */

@Injectable()
export class EmployeesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** The roster. Soft-deleted therapists are gone from it; ON_LEAVE ones are not. */
  async findMany(query: ListEmployeesQuery, actor: AuthUser): Promise<EmployeeView[]> {
    const where: Prisma.EmployeeWhereInput = { branchId: actor.branchId, deletedAt: null };
    if (query.status) where.status = query.status;

    const rows = await this.prisma.employee.findMany({ where, orderBy: { displayName: 'asc' } });
    return rows.map((row) => presentEmployee(row, actor));
  }

  /**
   * MANAGER+ reads anyone; a THERAPIST reads only themselves, and gets a 404 on
   * anyone else rather than a 403 — walking ids should not tell them who exists.
   */
  async findOne(id: string, actor: AuthUser): Promise<EmployeeView> {
    const employee = await this.findInBranch(id, actor.branchId);
    if (!isManagerOrAbove(actor.role) && actor.employeeId !== employee.id) {
      throw new NotFoundException(apiError(ErrorCode.NOT_FOUND, 'No such employee in this branch.'));
    }
    return presentEmployee(employee, actor);
  }

  async create(dto: CreateEmployeeDto, actor: AuthUser): Promise<EmployeeView> {
    const employee = await this.prisma.employee.create({
      data: {
        // From the TOKEN, never the body. §6.6.
        branchId: actor.branchId,
        displayName: dto.displayName,
        legalName: dto.legalName ?? null,
        phone: dto.phone ?? null,
        status: dto.status ?? EmployeeStatus.ACTIVE,
        commissionBps: dto.commissionBps ?? 0,
        hiredOn: dto.hiredOn ? dateColumn(dto.hiredOn) : null,
        photoUrl: dto.photoUrl ?? null,
      },
    });
    return presentEmployee(employee, actor);
  }

  /** `commissionBps` cannot arrive here — it has its own audited endpoint. */
  async update(id: string, dto: UpdateEmployeeDto, actor: AuthUser): Promise<EmployeeView> {
    const employee = await this.findInBranch(id, actor.branchId);

    const updated = await this.prisma.employee.update({
      where: { id: employee.id },
      data: {
        ...(dto.displayName !== undefined ? { displayName: dto.displayName } : {}),
        ...(dto.legalName !== undefined ? { legalName: dto.legalName } : {}),
        ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
        ...(dto.hiredOn !== undefined
          ? { hiredOn: dto.hiredOn === null ? null : dateColumn(dto.hiredOn) }
          : {}),
        ...(dto.photoUrl !== undefined ? { photoUrl: dto.photoUrl } : {}),
      },
    });
    return presentEmployee(updated, actor);
  }

  /**
   * ACTIVE / ON_LEAVE / INACTIVE. Status does not release a booking: a therapist
   * going on leave with work on tonight's grid is reception's problem to move,
   * not something this endpoint should silently cancel.
   */
  async setStatus(
    id: string,
    dto: UpdateEmployeeStatusDto,
    actor: AuthUser,
  ): Promise<EmployeeView> {
    const employee = await this.findInBranch(id, actor.branchId);
    const updated = await this.prisma.employee.update({
      where: { id: employee.id },
      data: { status: dto.status },
    });
    return presentEmployee(updated, actor);
  }

  /**
   * A commission change is money: it decides what the business owes this
   * therapist on every treatment from here on. Audited with before and after,
   * in the same transaction as the write, because the entry that matters is the
   * one produced months later when the rate is disputed. §9.6, §9.7.
   *
   * Existing ledger entries are NOT recalculated. Commission already accrued at
   * the old rate is a fact, not a projection.
   */
  async setCommission(
    id: string,
    dto: UpdateEmployeeCommissionDto,
    actor: AuthUser,
    ctx: RequestContext,
  ): Promise<EmployeeView> {
    const employee = await this.findInBranch(id, actor.branchId);

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.employee.update({
        where: { id: employee.id },
        data: { commissionBps: dto.commissionBps },
      });

      await this.audit.write(tx, ctx, {
        action: AuditAction.EMPLOYEE_COMMISSION_CHANGED,
        entityType: 'Employee',
        entityId: row.id,
        // pickAuditFields drops legalName along with the rest of the PII, so the
        // audit log never becomes the back door into a restricted field. §9.6.
        beforeState: pickAuditFields(employee),
        afterState: { ...pickAuditFields(row), note: dto.note ?? null },
      });

      return row;
    });

    return presentEmployee(updated, actor);
  }

  /**
   * Soft delete, always. A therapist's name is on completed reservations, tips
   * and ledger entries going back years, and a hard delete would either fail on
   * the foreign keys or orphan a payout dispute. §3.5.
   */
  async remove(id: string, actor: AuthUser): Promise<EmployeeView> {
    const employee = await this.findInBranch(id, actor.branchId);

    const upcoming = await this.prisma.reservation.count({
      where: {
        employeeId: employee.id,
        branchId: actor.branchId,
        startsAt: { gte: new Date() },
        status: { in: [ReservationStatus.SCHEDULED, ReservationStatus.IN_PROGRESS] },
      },
    });
    if (upcoming > 0) {
      throw new ConflictException(
        apiError(
          ErrorCode.EMPLOYEE_HAS_FUTURE_BOOKINGS,
          'That therapist still has bookings ahead of them. Move or cancel those first.',
          { upcoming },
        ),
      );
    }

    const removed = await this.prisma.employee.update({
      where: { id: employee.id },
      data: { deletedAt: new Date(), status: EmployeeStatus.INACTIVE },
    });
    return presentEmployee(removed, actor);
  }

  /** Branch and soft-delete in the `where`: another branch's employee simply does not exist. */
  private async findInBranch(id: string, branchId: string): Promise<Employee> {
    const employee = await this.prisma.employee.findFirst({
      where: { id, branchId, deletedAt: null },
    });
    if (!employee) {
      throw new NotFoundException(apiError(ErrorCode.NOT_FOUND, 'No such employee in this branch.'));
    }
    return employee;
  }
}
