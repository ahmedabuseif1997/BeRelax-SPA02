import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { User } from '@prisma/client';
import { ErrorCode, UserRole } from '@berelax/contracts';
import { AuditAction, AuditService, pickAuditFields } from '../common/audit.service';
import type { AuthUser, RequestContext } from '../common/request-context';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService, auditContext } from './auth.service';
import { PasswordService } from './password.service';
import { toPublicUser } from './dto';
import type { CreateUserDto, PublicUser, UpdateUserDto } from './dto';

/** A temporary password is shown once, at the moment it is created, and never again. */
export interface CreatedUser {
  user: PublicUser;
  temporaryPassword: string;
}

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
  ) {}

  async create(dto: CreateUserDto, actor: AuthUser, ctx: RequestContext): Promise<CreatedUser> {
    // The new account lands in the actor's branch. The body is not consulted. §6.6.
    const branchId = actor.branchId;

    if (dto.role === UserRole.THERAPIST && !dto.employeeId) {
      throw new UnprocessableEntityException({
        error: {
          code: ErrorCode.VALIDATION_FAILED,
          message: 'A therapist login must be linked to an employee record.',
          details: { issues: [{ path: 'employeeId', message: 'Required for THERAPIST.' }] },
        },
      });
    }
    if (dto.employeeId) await this.assertEmployeeLinkable(dto.employeeId, branchId);

    const temporaryPassword = this.passwords.generateTemporary();
    const passwordHash = await this.passwords.hash(temporaryPassword);
    const context = auditContext(ctx, actor);

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const row = await tx.user.create({
          data: {
            branchId,
            email: dto.email,
            fullName: dto.fullName,
            role: dto.role,
            employeeId: dto.employeeId ?? null,
            passwordHash,
            // §6.1: the temporary password gets one use.
            mustChangePassword: true,
          },
        });
        await this.audit.write(tx, context, {
          action: AuditAction.USER_CREATED,
          entityType: 'User',
          entityId: row.id,
          afterState: pickAuditFields(row),
        });
        return row;
      });

      return { user: toPublicUser(created), temporaryPassword };
    } catch (error) {
      throw this.asConflict(error);
    }
  }

  async update(
    id: string,
    dto: UpdateUserDto,
    actor: AuthUser,
    ctx: RequestContext,
  ): Promise<PublicUser> {
    const existing = await this.findInBranch(id, actor.branchId);

    // An owner who demotes or disables themselves locks the business out of user
    // management entirely, and only another owner could undo it.
    const demotesSelf = dto.role !== undefined && dto.role !== existing.role;
    if (existing.id === actor.id && (demotesSelf || dto.isActive === false)) {
      throw new UnprocessableEntityException({
        error: {
          code: ErrorCode.VALIDATION_FAILED,
          message: 'You cannot change your own role or disable your own account.',
        },
      });
    }

    const targetRole = dto.role ?? existing.role;
    const targetEmployeeId = dto.employeeId === undefined ? existing.employeeId : dto.employeeId;
    if (targetRole === UserRole.THERAPIST && !targetEmployeeId) {
      throw new UnprocessableEntityException({
        error: {
          code: ErrorCode.VALIDATION_FAILED,
          message: 'A therapist login must be linked to an employee record.',
          details: { issues: [{ path: 'employeeId', message: 'Required for THERAPIST.' }] },
        },
      });
    }
    if (dto.employeeId) await this.assertEmployeeLinkable(dto.employeeId, actor.branchId, id);

    const roleChanged = dto.role !== undefined && dto.role !== existing.role;
    const beingDisabled = dto.isActive === false && existing.isActive;
    const now = new Date();
    const context = auditContext(ctx, actor);

    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        const row = await tx.user.update({
          where: { id },
          data: {
            ...(dto.fullName !== undefined ? { fullName: dto.fullName } : {}),
            ...(dto.role !== undefined ? { role: dto.role } : {}),
            ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
            ...(dto.employeeId !== undefined ? { employeeId: dto.employeeId } : {}),
          },
        });

        if (roleChanged) {
          await this.audit.write(tx, context, {
            action: AuditAction.USER_ROLE_CHANGED,
            entityType: 'User',
            entityId: row.id,
            beforeState: { role: existing.role },
            afterState: { role: row.role },
          });
        }

        if (beingDisabled) {
          // Disabling an account that keeps a live refresh token is not disabling it.
          const { count } = await tx.refreshToken.updateMany({
            where: { userId: id, revokedAt: null },
            data: { revokedAt: now },
          });
          await this.audit.write(tx, context, {
            action: AuditAction.USER_DISABLED,
            entityType: 'User',
            entityId: row.id,
            afterState: { isActive: false, sessionsRevoked: count },
          });
        }

        return row;
      });

      return toPublicUser(updated);
    } catch (error) {
      throw this.asConflict(error);
    }
  }

  /**
   * A fresh temporary password, every session ended, and `mustChangePassword` back
   * on: the same state a brand-new account is in.
   */
  async resetPassword(
    id: string,
    actor: AuthUser,
    ctx: RequestContext,
  ): Promise<{ user: PublicUser; temporaryPassword: string }> {
    const existing = await this.findInBranch(id, actor.branchId);
    const temporaryPassword = this.passwords.generateTemporary();
    const passwordHash = await this.passwords.hash(temporaryPassword);
    const now = new Date();
    const context = auditContext(ctx, actor);

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.user.update({
        where: { id: existing.id },
        data: {
          passwordHash,
          mustChangePassword: true,
          // Also retires every access token issued before this moment (§6.2 is
          // enforced by JwtAuthGuard comparing `iat` against this column).
          passwordChangedAt: now,
          failedLoginCount: 0,
          lockedUntil: null,
        },
      });
      await tx.refreshToken.updateMany({
        where: { userId: existing.id, revokedAt: null },
        data: { revokedAt: now },
      });
      await this.audit.write(tx, context, {
        action: AuditAction.PASSWORD_RESET,
        entityType: 'User',
        entityId: existing.id,
        afterState: { self: false, sessionsRevoked: true },
      });
      return row;
    });

    return { user: toPublicUser(updated), temporaryPassword };
  }

  /** Spec §6.3: what you press when a therapist's phone is lost. */
  async revokeSessions(
    id: string,
    actor: AuthUser,
    ctx: RequestContext,
  ): Promise<{ revoked: number }> {
    const existing = await this.findInBranch(id, actor.branchId);
    return this.auth.revokeAllSessions(existing.id, auditContext(ctx, actor));
  }

  /**
   * Branch and soft-delete are in the `where`, not checked afterwards, so a user
   * from another branch is indistinguishable from one that does not exist.
   */
  private async findInBranch(id: string, branchId: string): Promise<User> {
    const user = await this.prisma.user.findFirst({ where: { id, branchId, deletedAt: null } });
    if (!user) {
      throw new NotFoundException({
        error: { code: ErrorCode.NOT_FOUND, message: 'No such user.' },
      });
    }
    return user;
  }

  private async assertEmployeeLinkable(
    employeeId: string,
    branchId: string,
    exceptUserId?: string,
  ): Promise<void> {
    const employee = await this.prisma.employee.findFirst({
      where: { id: employeeId, branchId, deletedAt: null },
      select: { id: true },
    });
    if (!employee) {
      throw new UnprocessableEntityException({
        error: {
          code: ErrorCode.VALIDATION_FAILED,
          message: 'That employee does not exist in this branch.',
          details: { issues: [{ path: 'employeeId', message: 'Unknown employee.' }] },
        },
      });
    }
    const linked = await this.prisma.user.findFirst({
      where: { employeeId, deletedAt: null, ...(exceptUserId ? { id: { not: exceptUserId } } : {}) },
      select: { id: true },
    });
    if (linked) {
      throw new ConflictException({
        error: {
          code: ErrorCode.VALIDATION_FAILED,
          message: 'That employee already has a login.',
          details: { issues: [{ path: 'employeeId', message: 'Already linked.' }] },
        },
      });
    }
  }

  /**
   * The uniqueness checks above lose a race under concurrency; the partial index on
   * lower(email) and the unique employee_id are what actually hold the line.
   */
  private asConflict(error: unknown): unknown {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return new ConflictException({
        error: {
          code: ErrorCode.VALIDATION_FAILED,
          message: 'That email address or employee already has a login.',
        },
      });
    }
    return error;
  }
}
