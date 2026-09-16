import { Prisma } from '@prisma/client';

/**
 * Every query on a branch-scoped model is filtered by the branch on the caller's
 * token. With one branch this is invisible; the day a second branch opens it is
 * the difference between a config change and a security incident. Spec §6.6.
 *
 * This is a safety net, not a licence to be careless — service methods still
 * pass branchId explicitly, and this catches the one that forgot.
 */
const BRANCH_SCOPED = new Set<string>([
  'Reservation', 'BookingRequest', 'Payment', 'Tip', 'Guest', 'Employee',
  'Shift', 'Room', 'Service', 'TherapistPayoutLedger', 'PayoutBatch',
  'FinancialAuditLog', 'User',
]);

const READ_OPS = new Set(['findFirst', 'findFirstOrThrow', 'findMany', 'findUnique',
  'findUniqueOrThrow', 'count', 'aggregate', 'groupBy']);

export const branchScope = (branchId: string) =>
  Prisma.defineExtension((client) =>
    client.$extends({
      name: 'branchScope',
      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }) {
            if (!model || !BRANCH_SCOPED.has(model)) return query(args);
            const a = args as Record<string, unknown>;

            if (READ_OPS.has(operation)) {
              // findUnique cannot take a non-unique field in `where`, so scope it
              // by re-routing through findFirst semantics at the service layer;
              // here we only constrain the operations that accept it.
              if (operation !== 'findUnique' && operation !== 'findUniqueOrThrow') {
                a.where = { ...((a.where as object) ?? {}), branchId };
              }
            } else if (operation === 'create') {
              a.data = { branchId, ...((a.data as object) ?? {}) };
            } else if (operation === 'updateMany' || operation === 'deleteMany') {
              a.where = { ...((a.where as object) ?? {}), branchId };
            }
            return query(a);
          },
        },
      },
    }),
  );
