import { Module } from '@nestjs/common';
import { ComplianceController } from './compliance.controller';
import { GuestComplianceController } from './guest-compliance.controller';
import { GuestErasureService } from './guest-erasure.service';
import { GuestExportService } from './guest-export.service';
import { ProcessingRegisterService } from './processing-register.service';
import { RetentionService } from './retention.service';

/**
 * UAE PDPL, §11 — the part of the system that decides whether the business may
 * lawfully hold what it holds.
 *
 * Separate from GuestsModule on purpose. Reception's guest book is a CRUD
 * surface a receptionist uses forty times a night; this is four operations a
 * manager or the owner performs a handful of times a year, every one of which is
 * answering a legal obligation. Mixing them would put an erasure endpoint one
 * missing decorator away from the RECEPTIONIST+ gate on the controller next to it.
 *
 * `GuestErasureService` is exported because it is the ONLY way a guest is
 * anonymised: the retention job (§11.6) calls it rather than writing its own
 * update, so that "erased" has exactly one meaning in this codebase.
 *
 * PrismaService arrives from the global PrismaModule, AuditService from the
 * global CommonModule, and ConfigService from the global ConfigModule.
 */
@Module({
  controllers: [GuestComplianceController, ComplianceController],
  providers: [GuestExportService, GuestErasureService, RetentionService, ProcessingRegisterService],
  exports: [GuestErasureService],
})
export class ComplianceModule {}
