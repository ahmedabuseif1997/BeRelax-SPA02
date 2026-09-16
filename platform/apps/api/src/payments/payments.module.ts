import { Module } from '@nestjs/common';
import { AuditQueryService } from './audit-query.service';
import { AuditController } from './audit.controller';
import { EarningsController } from './earnings.controller';
import { LedgerController } from './ledger.controller';
import { LedgerService } from './ledger.service';
import { PaymentsController } from './payments.controller';
import { PayoutHandler } from './payout.handler';
import { PayoutsController } from './payouts.controller';
import { RefundHandler } from './refund.handler';
import { TipReversalHandler } from './tip-reversal.handler';
import { TipsController } from './tips.controller';

/**
 * The money layer: corrections, settlements and the record of both. §9.
 *
 * Each write lives in its own handler for the same reason check-in and checkout
 * do — they are the parts of this system somebody will argue with you about, and
 * a handler buried in a CRUD service is a handler that stops getting read. The
 * read side is two services: one for what a therapist is owed, one for the audit
 * log that proves it.
 *
 * PrismaService comes from the global PrismaModule and AuditService from the
 * global CommonModule; nothing here is exported, because every route into this
 * module is an HTTP route with a role gate on it.
 */
@Module({
  controllers: [
    PaymentsController,
    TipsController,
    PayoutsController,
    LedgerController,
    EarningsController,
    AuditController,
  ],
  providers: [RefundHandler, TipReversalHandler, PayoutHandler, LedgerService, AuditQueryService],
})
export class PaymentsModule {}
