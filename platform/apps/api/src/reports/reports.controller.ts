import { Controller, Get, Query } from '@nestjs/common';
import {
  AttributionReportQuery,
  DailyReportQuery,
  RevenueReportQuery,
  TipsReportQuery,
  UtilisationReportQuery,
  attributionReportQuerySchema,
  dailyReportQuerySchema,
  revenueReportQuerySchema,
  tipsReportQuerySchema,
  utilisationReportQuerySchema,
} from '@berelax/contracts';
import { CurrentUser, Roles } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import type { AuthUser } from '../common/request-context';
import { MANAGER_PLUS } from '../payments/money.support';
import { AttributionReportService, type AttributionReportView } from './attribution-report.service';
import { DailyReportService, type DailyReportView } from './daily-report.service';
import { RevenueReportService, type RevenueReportView } from './revenue-report.service';
import { TipsReportService, type TipsReportView } from './tips-report.service';
import {
  UtilisationReportService,
  type UtilisationReportView,
} from './utilisation-report.service';

/**
 * Every route here is OWNER or MANAGER, declared once on the class because the
 * whole controller is financial. §6.4 draws that line deliberately: reception
 * takes money all evening without ever seeing the totals, because the person
 * handling cash should not also be the person auditing it. A receptionist who
 * reaches any of these gets 403 INSUFFICIENT_ROLE from `RolesGuard`.
 *
 * `branchId` comes off the token in every handler and never from the query
 * string. With one branch that is invisible; the day a second one opens it is
 * the difference between a config change and a security incident. §6.6.
 */
@Controller('reports')
@Roles(...MANAGER_PLUS)
export class ReportsController {
  constructor(
    private readonly dailyReport: DailyReportService,
    private readonly revenueReport: RevenueReportService,
    private readonly utilisationReport: UtilisationReportService,
    private readonly tipsReport: TipsReportService,
    private readonly attributionReport: AttributionReportService,
  ) {}

  /** The close-out sheet for one trading night, defaulting to tonight. §12.1: p95 < 600 ms. */
  @Get('daily')
  daily(
    @Query(new ZodValidationPipe(dailyReportQuerySchema)) query: DailyReportQuery,
    @CurrentUser() actor: AuthUser,
  ): Promise<DailyReportView> {
    return this.dailyReport.daily(query, actor);
  }

  /** Base revenue over time. Tips ride alongside it, labelled, never inside it. §9.1. */
  @Get('revenue')
  revenue(
    @Query(new ZodValidationPipe(revenueReportQuerySchema)) query: RevenueReportQuery,
    @CurrentUser() actor: AuthUser,
  ): Promise<RevenueReportView> {
    return this.revenueReport.revenue(query, actor);
  }

  /** Booked minutes over ROSTERED minutes, per therapist. */
  @Get('therapist-utilisation')
  utilisation(
    @Query(new ZodValidationPipe(utilisationReportQuerySchema)) query: UtilisationReportQuery,
    @CurrentUser() actor: AuthUser,
  ): Promise<UtilisationReportView> {
    return this.utilisationReport.utilisation(query, actor);
  }

  /** Earned by mode, by therapist and by night — plus what is still owed out. §9.2, §9.3. */
  @Get('tips')
  tips(
    @Query(new ZodValidationPipe(tipsReportQuerySchema)) query: TipsReportQuery,
    @CurrentUser() actor: AuthUser,
  ): Promise<TipsReportView> {
    return this.tipsReport.tips(query, actor);
  }

  /** Channel ROI, first touch and last touch, and the gap between them. §10.6. */
  @Get('attribution')
  attribution(
    @Query(new ZodValidationPipe(attributionReportQuerySchema)) query: AttributionReportQuery,
    @CurrentUser() actor: AuthUser,
  ): Promise<AttributionReportView> {
    return this.attributionReport.attribution(query, actor);
  }
}
