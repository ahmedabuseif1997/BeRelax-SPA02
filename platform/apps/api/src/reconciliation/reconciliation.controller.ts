import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  reconciliationDaySchema,
  reconciliationHistoryQuerySchema,
  submitReconciliationSchema,
  type ReconciliationHistoryQuery,
  type SubmitReconciliationDto,
} from '@berelax/contracts';
import { Ctx, CurrentUser, Roles } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import type { AuthUser, RequestContext } from '../common/request-context';
import { MANAGER_PLUS } from '../payments/money.support';
import { CloseOutSheetService, type CloseOutSheetView } from './close-out-sheet.service';
import {
  ReconciliationService,
  type ReconciliationHistoryView,
  type ReconciliationResultView,
} from './reconciliation.service';
import type { StreakView } from './reconciliation.support';

/**
 * The parallel pilot, §14 Phase 7.
 *
 * MANAGER+ on the whole controller, for the reason §6.4 gives the reports:
 * reception takes money all evening and a receptionist reconciling their own
 * night against their own drawer is not a control, it is a formality. The
 * person who counted the cash hands over the count; somebody else signs it off.
 *
 * `branchId` comes off the token in every handler and never from the path or
 * the query (§6.6), and every figure crossing this boundary is integer fils
 * (§3.1) — the dashboard's amount pad builds them from digit characters so no
 * decimal point is ever offered to anybody.
 */
@Controller('reconciliation')
@Roles(...MANAGER_PLUS)
export class ReconciliationController {
  constructor(
    private readonly reconciliation: ReconciliationService,
    private readonly sheet: CloseOutSheetService,
  ) {}

  /**
   * How many consecutive nights have matched, and is it five yet?
   *
   * Declared before the parameterised routes so `streak` is never read as a
   * trading day — it could not parse as one, but a route table that depends on
   * a validation failure to disambiguate itself is one bad refactor from a
   * confusing 422.
   */
  @Get('streak')
  streak(@CurrentUser() actor: AuthUser): Promise<StreakView> {
    return this.reconciliation.streak(actor);
  }

  /** The pilot's history: every submission in the window, corrections included. */
  @Get()
  history(
    @Query(new ZodValidationPipe(reconciliationHistoryQuerySchema))
    query: ReconciliationHistoryQuery,
    @CurrentUser() actor: AuthUser,
  ): Promise<ReconciliationHistoryView> {
    return this.reconciliation.history(query, actor);
  }

  /** The sheet reception prints and ticks off at close. */
  @Get(':businessDay/sheet')
  closeOutSheet(
    @Param('businessDay', new ZodValidationPipe(reconciliationDaySchema)) day: string,
    @CurrentUser() actor: AuthUser,
  ): Promise<CloseOutSheetView> {
    return this.sheet.sheet(day, actor);
  }

  /**
   * What the paper says, compared line by line with what the system says.
   *
   * NOT `@Idempotent()`, and that is deliberate. The idempotency interceptor
   * exists so a retried tap does not charge a guest twice (§7.6); this endpoint
   * moves no money, and a second submission for the same night is a MEANINGFUL
   * act — a correction, recorded as a new row beside the first. Replaying the
   * stored response instead would quietly swallow the re-run a manager did
   * after closing the session they had forgotten.
   */
  @Post(':businessDay')
  submit(
    @Param('businessDay', new ZodValidationPipe(reconciliationDaySchema)) day: string,
    @Body(new ZodValidationPipe(submitReconciliationSchema)) dto: SubmitReconciliationDto,
    @CurrentUser() actor: AuthUser,
    @Ctx() ctx: RequestContext,
  ): Promise<ReconciliationResultView> {
    return this.reconciliation.submit(day, dto, actor, ctx);
  }
}
