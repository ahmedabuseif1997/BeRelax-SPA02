import { Module } from '@nestjs/common';
import { BookingRequestsController } from './booking-requests.controller';
import { BookingRequestsService } from './booking-requests.service';

/**
 * The unconfirmed half of the intake pipeline. §1.1.
 *
 * It does not import ReservationsModule even though `convert` creates a
 * reservation: the whole conversion has to commit or roll back as one
 * transaction, and Prisma's `$transaction` does not nest, so the insert is made
 * on this transaction's client rather than through the other service. The
 * booking rules it has to respect are the exclusion constraints, and those live
 * in the database where both modules meet them on equal terms. §5.2.
 *
 * PrismaService and AuditService arrive from the global PrismaModule and
 * CommonModule.
 */
@Module({
  controllers: [BookingRequestsController],
  providers: [BookingRequestsService],
  exports: [BookingRequestsService],
})
export class BookingRequestsModule {}
