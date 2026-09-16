import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { LedgerQuery, ledgerQuerySchema } from '@berelax/contracts';
import { CurrentUser, Roles } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import type { AuthUser } from '../common/request-context';
import { BalanceView, LedgerService, LedgerView } from './ledger.service';
import { MANAGER_PLUS_OR_THERAPIST } from './money.support';

/**
 * MANAGER+ for anyone, or a THERAPIST for themselves — the guard opens the door
 * to the role and `assertMayReadEmployeeRecord` decides whose record it is.
 * A therapist reading a colleague's ledger gets a 403, every time. §6.4.
 */
@Controller('ledger')
export class LedgerController {
  constructor(private readonly ledger: LedgerService) {}

  /** Declared before `:employeeId` so the two-segment route wins the match. */
  @Get(':employeeId/balance')
  @Roles(...MANAGER_PLUS_OR_THERAPIST)
  balance(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @CurrentUser() actor: AuthUser,
  ): Promise<BalanceView> {
    return this.ledger.balance(employeeId, actor);
  }

  /** Every line, with the booking, the person who entered it and the batch. §9.7. */
  @Get(':employeeId')
  @Roles(...MANAGER_PLUS_OR_THERAPIST)
  entries(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Query(new ZodValidationPipe(ledgerQuerySchema)) query: LedgerQuery,
    @CurrentUser() actor: AuthUser,
  ): Promise<LedgerView> {
    return this.ledger.entries(employeeId, query, actor);
  }
}
