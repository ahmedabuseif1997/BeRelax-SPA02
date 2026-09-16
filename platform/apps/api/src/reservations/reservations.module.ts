import { Module } from '@nestjs/common';
import { AuditService } from '../common/audit.service';
import { CheckInHandler } from './check-in.handler';
import { CheckoutHandler } from './checkout.handler';
import { ReservationsController } from './reservations.controller';
import { ReservationsService } from './reservations.service';

/**
 * The two money handlers are separate providers rather than methods on the
 * service: check-in and checkout are the two halves of the financial workflow
 * and each is long enough that burying them in a CRUD service is how they stop
 * getting read. §8.
 *
 * PrismaService arrives from the global PrismaModule. AuditService is stateless
 * and is provided here until a shared CommonModule exports it.
 */
@Module({
  controllers: [ReservationsController],
  providers: [ReservationsService, CheckInHandler, CheckoutHandler, AuditService],
  exports: [ReservationsService],
})
export class ReservationsModule {}
