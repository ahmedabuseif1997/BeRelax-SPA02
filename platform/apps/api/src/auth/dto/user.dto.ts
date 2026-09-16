import { z } from 'zod';
import { createUserSchema, UserRole } from '@berelax/contracts';
import type { User } from '@prisma/client';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';

export type { CreateUserDto } from '@berelax/contracts';

/**
 * Not in @berelax/contracts because nothing outside the dashboard sends it.
 * `branchId` and `password` are absent on purpose: the branch comes from the
 * actor's account (§6.6) and a password only ever from reset-password.
 */
export const updateUserSchema = z
  .object({
    fullName: z.string().min(2).max(120).optional(),
    role: z.nativeEnum(UserRole).optional(),
    isActive: z.boolean().optional(),
    employeeId: z.string().uuid().nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Send at least one field to change.');
export type UpdateUserDto = z.infer<typeof updateUserSchema>;

export const createUserBodyPipe = new ZodValidationPipe(createUserSchema);
export const updateUserBodyPipe = new ZodValidationPipe(updateUserSchema);

/** What a user row looks like from outside. No hash, no lock counters. */
export interface PublicUser {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  branchId: string;
  employeeId: string | null;
  isActive: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    branchId: user.branchId,
    employeeId: user.employeeId,
    isActive: user.isActive,
    mustChangePassword: user.mustChangePassword,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
  };
}
