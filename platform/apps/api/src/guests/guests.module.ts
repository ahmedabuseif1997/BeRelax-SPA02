import { Module } from '@nestjs/common';
import { GuestsController } from './guests.controller';
import { GuestsService } from './guests.service';

/**
 * PrismaService arrives from the global PrismaModule. Nothing here needs
 * AuditService: `financial_audit_log` records what changed about the money
 * (§9.6), and editing a guest's preferences is not that.
 */
@Module({
  controllers: [GuestsController],
  providers: [GuestsService],
  exports: [GuestsService],
})
export class GuestsModule {}
