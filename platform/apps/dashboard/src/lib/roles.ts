import { ROLE_RANK, UserRole } from '@berelax/contracts';

/**
 * The role matrix from spec §6.4, as the dashboard reads it.
 *
 * The interesting boundary is RECEPTIONIST vs MANAGER: reception takes money
 * all evening without ever seeing the totals, because the person handling cash
 * should not be the person auditing it. So a RECEPTIONIST must never be shown a
 * link to revenue reports — not a disabled one, not a 403 they can bump into.
 *
 * The API enforces all of this again with `RolesGuard`. This copy exists so the
 * screen never offers a receptionist something the server will refuse.
 */
export type Capability =
  | 'grid.view'
  | 'reservation.create'
  | 'reservation.checkIn'
  | 'reservation.checkout'
  | 'reservation.noShow'
  | 'reservation.cancelScheduled'
  | 'reservation.cancelInProgress'
  | 'payment.comp'
  | 'tip.confirmLarge'
  | 'reports.view'
  | 'earnings.viewOwn'
  | 'catalogue.manage'
  | 'users.manage';

const MATRIX: Record<Capability, readonly UserRole[]> = {
  'grid.view': [UserRole.OWNER, UserRole.MANAGER, UserRole.RECEPTIONIST, UserRole.THERAPIST],
  'reservation.create': [UserRole.OWNER, UserRole.MANAGER, UserRole.RECEPTIONIST],
  'reservation.checkIn': [UserRole.OWNER, UserRole.MANAGER, UserRole.RECEPTIONIST],
  'reservation.checkout': [UserRole.OWNER, UserRole.MANAGER, UserRole.RECEPTIONIST],
  'reservation.noShow': [UserRole.OWNER, UserRole.MANAGER, UserRole.RECEPTIONIST],
  'reservation.cancelScheduled': [UserRole.OWNER, UserRole.MANAGER, UserRole.RECEPTIONIST],
  // Money has already changed hands, so walking it back is a manager's call.
  'reservation.cancelInProgress': [UserRole.OWNER, UserRole.MANAGER],
  'payment.comp': [UserRole.OWNER, UserRole.MANAGER],
  'tip.confirmLarge': [UserRole.OWNER, UserRole.MANAGER],
  'reports.view': [UserRole.OWNER, UserRole.MANAGER],
  'earnings.viewOwn': [UserRole.OWNER, UserRole.MANAGER, UserRole.THERAPIST],
  'catalogue.manage': [UserRole.OWNER, UserRole.MANAGER],
  'users.manage': [UserRole.OWNER],
};

export function can(role: UserRole | undefined, capability: Capability): boolean {
  if (!role) return false;
  return MATRIX[capability].includes(role);
}

export function isManagerOrAbove(role: UserRole | undefined): boolean {
  return role !== undefined && ROLE_RANK[role] >= ROLE_RANK[UserRole.MANAGER];
}

export function roleLabel(role: UserRole): string {
  switch (role) {
    case UserRole.OWNER:
      return 'Owner';
    case UserRole.MANAGER:
      return 'Manager';
    case UserRole.RECEPTIONIST:
      return 'Reception';
    case UserRole.THERAPIST:
      return 'Therapist';
    default:
      return String(role);
  }
}
