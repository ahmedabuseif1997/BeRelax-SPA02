import { Module } from '@nestjs/common';
import { ReportsModule } from '../reports/reports.module';
import { CloseOutSheetService } from './close-out-sheet.service';
import { ReconciliationConfig } from './reconciliation.config';
import { ReconciliationController } from './reconciliation.controller';
import { ReconciliationService } from './reconciliation.service';

/**
 * Phase 7 — the parallel pilot. §14.
 *
 * Two weeks of running this system beside reception's paper process, reconciled
 * nightly, switching over only when the numbers match for five consecutive
 * nights. Without a tool, "the numbers match" is somebody squinting at two
 * pieces of paper at 02:00, and the pilot either passes on optimism or never
 * ends at all.
 *
 * `ReportsModule` is imported for ONE provider: `DailyReportService`. The
 * system side of every comparison here is the close-out sheet the business
 * already reads at 02:00, not a second opinion about it. Where the close-out
 * did not expose a figure this needed — the net card position, the night broken
 * down by therapist, what is still in a room — it was added there and read from
 * here. A reconciliation tool with its own arithmetic is the thing that ends up
 * needing reconciling.
 *
 * PrismaService arrives from the global PrismaModule, AuditService from the
 * global CommonModule, ConfigService from the global ConfigModule. Nothing is
 * exported: every way in is an HTTP route with a MANAGER+ gate on it.
 */
@Module({
  imports: [ReportsModule],
  controllers: [ReconciliationController],
  providers: [ReconciliationService, CloseOutSheetService, ReconciliationConfig],
})
export class ReconciliationModule {}
