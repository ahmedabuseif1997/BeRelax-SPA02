import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

/** The environment variable that widens the cash line. Absent means zero. */
export const CASH_TOLERANCE_ENV = 'RECONCILIATION_CASH_TOLERANCE_FILS';

/**
 * How far the counted drawer may be out before the night is a mismatch.
 *
 * DEFAULT ZERO, and that default is the position, not a placeholder. §15.4 is
 * candid that the system cannot prove cash reached the drawer — all it can
 * offer is the variance, recorded and attributed — and a tolerance is how that
 * variance stops being recorded. Two dirhams a night, forgiven silently, is
 * seven hundred a year that nobody will ever be able to find, and a pilot whose
 * job is to expose exactly this class of problem must not start by hiding it.
 *
 * It is settable because a business may decide, with its eyes open and in
 * writing, that a few fils of rounding on a cash-only night is not worth a
 * manager's 02:00. When it is set, the value in force is STORED on every row
 * (`cash_tolerance_fils`), so a night signed off under a wide tolerance stays
 * visibly signed off under a wide tolerance, and changing the setting later
 * cannot retroactively turn a variance into a match.
 *
 * The card line has no equivalent and never will. §15.4's trust is extended to
 * cash because cash is counted by hand; the terminal's Z-report is printed by
 * the bank.
 *
 * WHY THIS IS READ HERE RATHER THAN FROM `config/env.ts`
 *
 * It is a setting for one endpoint in one phase of delivery, not a fact the
 * whole process needs to boot. `ConfigService` falls through to `process.env`
 * for keys the boot schema does not name, so it is read through the same
 * injected service as everything else and validated once, at construction —
 * loudly, because a tolerance that silently fell back to zero (or, worse, to
 * NaN) would be discovered during a dispute.
 */
@Injectable()
export class ReconciliationConfig {
  private readonly logger = new Logger(ReconciliationConfig.name);

  readonly cashToleranceFils: number;

  constructor(config: ConfigService) {
    this.cashToleranceFils = parseCashTolerance(config.get<string>(CASH_TOLERANCE_ENV));

    if (this.cashToleranceFils > 0) {
      // Not a debug line. A non-zero cash tolerance is a policy decision that
      // should be visible in the logs of the night it was first applied.
      this.logger.warn(
        `${CASH_TOLERANCE_ENV}=${this.cashToleranceFils}: a counted drawer may be out by up to ` +
          `${this.cashToleranceFils} fils and still be recorded as a match. The value in force ` +
          'is stored on every reconciliation.',
      );
    }
  }
}

/**
 * A whole, non-negative number of fils, or nothing.
 *
 * `z.coerce.number()` would read "2.50" as 2.5 and an empty string as 0, so the
 * string is matched against digits before it is ever a number — money is an
 * integer and the tool must not invite a decimal, least of all through its own
 * configuration (§3.1).
 */
const toleranceSchema = z
  .string()
  .trim()
  .regex(/^\d+$/, 'must be a whole number of fils — 500 for AED 5.00, never 5.00')
  .transform((raw) => Number.parseInt(raw, 10))
  .pipe(z.number().int().max(100_000_000));

export function parseCashTolerance(raw: string | undefined): number {
  // Unset, or set to nothing at all, means the default. .env.example ships
  // optional keys as KEY="" so their names are discoverable, which `env.ts`
  // already accounts for; this does the same rather than reading a blank
  // string as a broken setting.
  if (raw === undefined || raw.trim() === '') return 0;

  const parsed = toleranceSchema.safeParse(raw);
  if (!parsed.success) {
    // Thrown at construction, so it fails the process rather than the request.
    // A misconfigured tolerance discovered at boot is a five-second problem;
    // discovered in the middle of the pilot it invalidates the streak.
    throw new Error(
      `Invalid reconciliation configuration:\n  ${CASH_TOLERANCE_ENV}="${raw}" ` +
        `${parsed.error.issues[0]?.message ?? 'is not a valid tolerance'}.`,
    );
  }
  return parsed.data;
}
