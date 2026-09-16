import { Module } from '@nestjs/common';
import { ShiftsController } from './shifts.controller';
import { ShiftsService } from './shifts.service';

/**
 * Attendance, not money: a shift records who was here and when, and nothing in
 * it reaches the payout ledger. PrismaService arrives from the global
 * PrismaModule.
 */
@Module({
  controllers: [ShiftsController],
  providers: [ShiftsService],
  exports: [ShiftsService],
})
export class ShiftsModule {}
