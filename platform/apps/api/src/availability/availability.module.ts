import { Module } from '@nestjs/common';
import { AvailabilityController } from './availability.controller';
import { AvailabilityService } from './availability.service';

/**
 * Read-only, and deliberately holds no dependency on ReservationsModule: the
 * grid must never be in a position to hand a caller a "pre-checked" slot. It
 * reads rows and draws gaps; booking one is somebody else's transaction. §5.5.
 *
 * PrismaService arrives from the global PrismaModule.
 */
@Module({
  controllers: [AvailabilityController],
  providers: [AvailabilityService],
  exports: [AvailabilityService],
})
export class AvailabilityModule {}
