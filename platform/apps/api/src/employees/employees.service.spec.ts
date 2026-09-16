import { HttpException } from '@nestjs/common';
import type { Employee } from '@prisma/client';
import type { ApiErrorBody } from '@berelax/contracts';
import { EmployeeStatus, ErrorCode, UserRole } from '@berelax/contracts';
import { AuditService } from '../common/audit.service';
import type { AuthUser, RequestContext } from '../common/request-context';
import type { PrismaService } from '../prisma/prisma.service';
import { EmployeesService, presentEmployee } from './employees.service';

const EMPLOYEE_ID = '0192cccc-0000-7000-8000-00000000000c';
const OTHER_EMPLOYEE_ID = '0192cccc-0000-7000-8000-00000000000f';
const BRANCH_ID = '0192bbbb-0000-7000-8000-00000000000b';
const USER_ID = '0192dddd-0000-7000-8000-00000000000d';

function employeeFixture(overrides: Partial<Employee> = {}): Employee {
  return {
    id: EMPLOYEE_ID,
    branchId: BRANCH_ID,
    displayName: 'Layla',
    legalName: 'Layla Nurhaliza Putri',
    phone: '+971501234567',
    status: 'ACTIVE',
    commissionBps: 1_000,
    hiredOn: new Date('2025-03-01T00:00:00.000Z'),
    photoUrl: null,
    createdAt: new Date('2025-03-01T08:00:00.000Z'),
    updatedAt: new Date('2026-09-10T08:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  };
}

function actorFixture(role: UserRole, employeeId?: string): AuthUser {
  return {
    id: USER_ID,
    role,
    branchId: BRANCH_ID,
    employeeId: employeeId ?? null,
    email: 'manager@berelax.ae',
    fullName: 'Manager',
  };
}

const CTX: RequestContext = {
  requestId: 'req_01JBQ7X8',
  branchId: BRANCH_ID,
  actorUserId: USER_ID,
  actorRole: UserRole.MANAGER,
};

type Tx = {
  employee: {
    findMany: jest.Mock;
    findFirst: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
  reservation: { count: jest.Mock };
  financialAuditLog: { create: jest.Mock };
};

function setup(options: { employee?: Employee | null; upcoming?: number } = {}) {
  const employee = options.employee === undefined ? employeeFixture() : options.employee;

  const tx: Tx = {
    employee: {
      findMany: jest.fn().mockResolvedValue([employeeFixture()]),
      findFirst: jest.fn().mockResolvedValue(employee),
      create: jest.fn(async ({ data }: { data: Employee }) => employeeFixture(data)),
      update: jest.fn(async ({ data }: { data: Partial<Employee> }) =>
        employeeFixture({ ...(employee ?? {}), ...data }),
      ),
    },
    reservation: { count: jest.fn().mockResolvedValue(options.upcoming ?? 0) },
    financialAuditLog: { create: jest.fn().mockResolvedValue({}) },
  };

  const prisma = {
    $transaction: jest.fn(async (cb: (client: Tx) => Promise<unknown>) => cb(tx)),
    employee: tx.employee,
    reservation: tx.reservation,
  } as unknown as PrismaService;

  return { tx, service: new EmployeesService(prisma, new AuditService()) };
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

describe('EmployeesService', () => {
  describe('legalName — restricted on the way out, §6.4', () => {
    it.each([UserRole.OWNER, UserRole.MANAGER])('shows %s the legal name', async (role) => {
      const { service } = setup();

      const [row] = await service.findMany({}, actorFixture(role));

      expect(row!.legalName).toBe('Layla Nurhaliza Putri');
    });

    it('shows a THERAPIST their own legal name', async () => {
      const { service } = setup();

      const view = await service.findOne(EMPLOYEE_ID, actorFixture(UserRole.THERAPIST, EMPLOYEE_ID));

      expect(view.legalName).toBe('Layla Nurhaliza Putri');
    });

    it('strips it for a RECEPTIONIST — the key is absent, not null', () => {
      const view = presentEmployee(employeeFixture(), actorFixture(UserRole.RECEPTIONIST));

      expect('legalName' in view).toBe(false);
      expect(JSON.stringify(view)).not.toContain('Nurhaliza');
    });

    it('strips it for a THERAPIST reading another therapist', () => {
      const view = presentEmployee(
        employeeFixture(),
        actorFixture(UserRole.THERAPIST, OTHER_EMPLOYEE_ID),
      );

      expect('legalName' in view).toBe(false);
    });

    it('strips it for a therapist login with no employee record linked', () => {
      const view = presentEmployee(employeeFixture(), actorFixture(UserRole.THERAPIST));

      expect('legalName' in view).toBe(false);
    });

    it('strips it from every path a row can leave by', async () => {
      const { service } = setup();
      const therapist = actorFixture(UserRole.THERAPIST, OTHER_EMPLOYEE_ID);

      const listed = await service.findMany({}, therapist);
      const created = await service.create({ displayName: 'Maya' }, therapist);
      const updated = await service.update(EMPLOYEE_ID, { displayName: 'Maya' }, therapist);
      const statused = await service.setStatus(
        EMPLOYEE_ID,
        { status: EmployeeStatus.ON_LEAVE },
        therapist,
      );
      const commissioned = await service.setCommission(
        EMPLOYEE_ID,
        { commissionBps: 1_500 },
        therapist,
        CTX,
      );

      for (const view of [listed[0]!, created, updated, statused, commissioned]) {
        expect('legalName' in view).toBe(false);
      }
    });

    it('404s a THERAPIST reading someone else, rather than 403ing and confirming they exist', async () => {
      const { service } = setup();

      const { status, body } = await caught(() =>
        service.findOne(EMPLOYEE_ID, actorFixture(UserRole.THERAPIST, OTHER_EMPLOYEE_ID)),
      );

      expect(status).toBe(404);
      expect(body.error.code).toBe(ErrorCode.NOT_FOUND);
    });
  });

  describe('findMany', () => {
    it('leaves soft-deleted employees out and scopes to the branch', async () => {
      const { service, tx } = setup();

      await service.findMany({}, actorFixture(UserRole.MANAGER));

      const { where } = tx.employee.findMany.mock.calls[0]![0] as {
        where: Record<string, unknown>;
      };
      expect(where).toEqual({ branchId: BRANCH_ID, deletedAt: null });
    });

    it('filters by status when asked', async () => {
      const { service, tx } = setup();

      await service.findMany({ status: EmployeeStatus.ON_LEAVE }, actorFixture(UserRole.MANAGER));

      const { where } = tx.employee.findMany.mock.calls[0]![0] as { where: { status: string } };
      expect(where.status).toBe('ON_LEAVE');
    });
  });

  describe('create', () => {
    it('takes branchId from the token and defaults the commission to nothing', async () => {
      const { service, tx } = setup();

      await service.create(
        { displayName: 'Maya', branchId: 'not-this-one' } as never,
        actorFixture(UserRole.MANAGER),
      );

      const { data } = tx.employee.create.mock.calls[0]![0] as { data: Employee };
      expect(data.branchId).toBe(BRANCH_ID);
      expect(data.commissionBps).toBe(0);
      expect(data.status).toBe('ACTIVE');
    });

    it('stores hiredOn as the UTC midnight a date column wants', async () => {
      const { service, tx } = setup();

      await service.create(
        { displayName: 'Maya', hiredOn: '2026-04-01' },
        actorFixture(UserRole.MANAGER),
      );

      const { data } = tx.employee.create.mock.calls[0]![0] as { data: Employee };
      expect(data.hiredOn).toEqual(new Date('2026-04-01T00:00:00.000Z'));
    });
  });

  describe('setCommission — audited with before and after, §9.6', () => {
    it('writes EMPLOYEE_COMMISSION_CHANGED carrying both rates', async () => {
      const { service, tx } = setup();

      await service.setCommission(
        EMPLOYEE_ID,
        { commissionBps: 1_500, note: 'promoted to senior' },
        actorFixture(UserRole.MANAGER),
        CTX,
      );

      const { data } = tx.financialAuditLog.create.mock.calls[0]![0] as {
        data: Record<string, unknown>;
      };
      expect(data).toMatchObject({
        action: 'EMPLOYEE_COMMISSION_CHANGED',
        entityType: 'Employee',
        entityId: EMPLOYEE_ID,
        requestId: 'req_01JBQ7X8',
      });
      expect((data.beforeState as Record<string, unknown>).commissionBps).toBe(1_000);
      expect((data.afterState as Record<string, unknown>).commissionBps).toBe(1_500);
      expect((data.afterState as Record<string, unknown>).note).toBe('promoted to senior');
    });

    it('keeps the legal name out of the audit snapshots too', async () => {
      const { service, tx } = setup();

      await service.setCommission(
        EMPLOYEE_ID,
        { commissionBps: 1_500 },
        actorFixture(UserRole.MANAGER),
        CTX,
      );

      const { data } = tx.financialAuditLog.create.mock.calls[0]![0] as {
        data: Record<string, unknown>;
      };
      expect(JSON.stringify(data)).not.toContain('Nurhaliza');
    });

    it('records the change in the same transaction as the write', async () => {
      const { service, tx } = setup();

      await service.setCommission(
        EMPLOYEE_ID,
        { commissionBps: 0 },
        actorFixture(UserRole.MANAGER),
        CTX,
      );

      // Same `tx` object: if the update rolls back, the entry claiming it happened goes too.
      expect(tx.employee.update).toHaveBeenCalledTimes(1);
      expect(tx.financialAuditLog.create).toHaveBeenCalledTimes(1);
    });

    it('does not touch the ledger: commission already accrued stays at the old rate', async () => {
      const { service, tx } = setup();

      await service.setCommission(
        EMPLOYEE_ID,
        { commissionBps: 2_000 },
        actorFixture(UserRole.MANAGER),
        CTX,
      );

      expect(tx.employee.update).toHaveBeenCalledWith({
        where: { id: EMPLOYEE_ID },
        data: { commissionBps: 2_000 },
      });
    });

    it('404s on an employee from another branch, writing nothing', async () => {
      const { service, tx } = setup({ employee: null });

      const { status } = await caught(() =>
        service.setCommission(
          EMPLOYEE_ID,
          { commissionBps: 1_500 },
          actorFixture(UserRole.MANAGER),
          CTX,
        ),
      );

      expect(status).toBe(404);
      expect(tx.financialAuditLog.create).not.toHaveBeenCalled();
    });
  });

  describe('setStatus', () => {
    it('moves a therapist to ON_LEAVE without touching their bookings', async () => {
      const { service, tx } = setup();

      const view = await service.setStatus(
        EMPLOYEE_ID,
        { status: EmployeeStatus.ON_LEAVE },
        actorFixture(UserRole.MANAGER),
      );

      expect(tx.employee.update).toHaveBeenCalledWith({
        where: { id: EMPLOYEE_ID },
        data: { status: 'ON_LEAVE' },
      });
      expect(view.status).toBe('ON_LEAVE');
    });
  });

  describe('remove — soft delete only, §3.5', () => {
    it('stamps deletedAt instead of deleting the row', async () => {
      const { service, tx } = setup();

      const view = await service.remove(EMPLOYEE_ID, actorFixture(UserRole.MANAGER));

      // The Prisma mock has no `delete` at all: a hard delete would throw here,
      // which is exactly the guarantee §3.5 asks for.
      const { data } = tx.employee.update.mock.calls[0]![0] as { data: Partial<Employee> };
      expect(data.deletedAt).toBeInstanceOf(Date);
      expect(data.status).toBe('INACTIVE');
      expect(view.id).toBe(EMPLOYEE_ID);
    });

    it('409s while they still have bookings ahead of them', async () => {
      const { service, tx } = setup({ upcoming: 3 });

      const { status, body } = await caught(() =>
        service.remove(EMPLOYEE_ID, actorFixture(UserRole.MANAGER)),
      );

      expect(status).toBe(409);
      expect(body.error.code).toBe(ErrorCode.EMPLOYEE_HAS_FUTURE_BOOKINGS);
      expect(body.error.details).toEqual({ upcoming: 3 });
      expect(tx.employee.update).not.toHaveBeenCalled();
    });

    it('counts only live bookings still to come', async () => {
      const { service, tx } = setup();

      await service.remove(EMPLOYEE_ID, actorFixture(UserRole.MANAGER));

      const { where } = tx.reservation.count.mock.calls[0]![0] as {
        where: { status: { in: string[] }; branchId: string };
      };
      expect(where.status.in).toEqual(['SCHEDULED', 'IN_PROGRESS']);
      expect(where.branchId).toBe(BRANCH_ID);
    });

    it('404s on an employee from another branch', async () => {
      const { service } = setup({ employee: null });

      const { status } = await caught(() =>
        service.remove(EMPLOYEE_ID, actorFixture(UserRole.MANAGER)),
      );

      expect(status).toBe(404);
    });
  });
});
