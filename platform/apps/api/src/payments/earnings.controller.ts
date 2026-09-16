import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { EarningsQuery, earningsQuerySchema } from '@berelax/contracts';
import { CurrentUser, Roles } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import type { AuthUser } from '../common/request-context';
import { EarningsView, LedgerService } from './ledger.service';
import { MANAGER_PLUS_OR_THERAPIST } from './money.support';

/**
 * The therapist's statement. Lives under `/employees` because that is whose
 * statement it is, while the ledger lives under `/ledger` because that is a
 * record of what the BUSINESS owes — the same separation §9.2 insists on, all
 * the way out to the URL.
 */
@Controller('employees')
export class EarningsController {
  constructor(private readonly ledger: LedgerService) {}

  @Get(':employeeId/earnings')
  @Roles(...MANAGER_PLUS_OR_THERAPIST)
  earnings(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Query(new ZodValidationPipe(earningsQuerySchema)) query: EarningsQuery,
    @CurrentUser() actor: AuthUser,
  ): Promise<EarningsView> {
    return this.ledger.earnings(employeeId, query, actor);
  }
}
