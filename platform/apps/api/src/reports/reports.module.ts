import { Module } from '@nestjs/common';
import { AttributionReportService } from './attribution-report.service';
import { DailyReportService } from './daily-report.service';
import { ReportsController } from './reports.controller';
import { RevenueReportService } from './revenue-report.service';
import { TipsReportService } from './tips-report.service';
import { UtilisationReportService } from './utilisation-report.service';

/**
 * The reporting layer. §7.4, OWNER/MANAGER only (§6.4).
 *
 * Read-only by construction: nothing in this module writes, and every service
 * in it reaches the database through `$queryRaw` with an explicit `branch_id`.
 * Money never leaves here as anything but integer fils — formatting to
 * "AED 250.00" happens once, in the dashboard (§3.1).
 *
 * One service per report rather than one `ReportsService` with five methods,
 * for the same reason the money module keeps a handler per write: each of these
 * is a page somebody will argue with, and a five-hundred-line service is one
 * nobody re-reads before changing.
 *
 * PrismaService comes from the global PrismaModule.
 *
 * `DailyReportService` is the one export, and it is exported for exactly one
 * reason: the parallel pilot's nightly reconciliation (§14, Phase 7) compares
 * reception's paper against the system's close-out, and it must compare against
 * THESE figures. A second implementation of "what the spa took last night" is
 * how a reconciliation tool becomes the thing that needs reconciling.
 */
@Module({
  controllers: [ReportsController],
  providers: [
    DailyReportService,
    RevenueReportService,
    UtilisationReportService,
    TipsReportService,
    AttributionReportService,
  ],
  exports: [DailyReportService],
})
export class ReportsModule {}
