import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  CancelReservationDto,
  CheckInDto,
  CheckoutDto,
  CreateReservationDto,
  UserRole,
  cancelReservationSchema,
  checkInSchema,
  checkoutSchema,
  createReservationSchema,
} from '@berelax/contracts';
import { Ctx, CurrentUser, Idempotent, Roles } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import type { AuthUser, RequestContext } from '../common/request-context';
import { CheckInHandler, CheckInView } from './check-in.handler';
import { CheckoutHandler, CheckoutView } from './checkout.handler';
import {
  ListReservationsQuery,
  ReservationView,
  ReservationsService,
  listReservationsQuerySchema,
  rescheduleReservationSchema,
  type RescheduleReservationDto,
} from './reservations.service';

/** Every staff role can read the grid; a THERAPIST is narrowed to their own. §6.4. */
const ALL_STAFF = [
  UserRole.OWNER,
  UserRole.MANAGER,
  UserRole.RECEPTIONIST,
  UserRole.THERAPIST,
] as const;

/** RECEPTIONIST and up: reception takes money all evening without seeing the totals. §6.4. */
const RECEPTIONIST_PLUS = [UserRole.OWNER, UserRole.MANAGER, UserRole.RECEPTIONIST] as const;

@Controller('reservations')
export class ReservationsController {
  constructor(
    private readonly reservations: ReservationsService,
    private readonly checkInHandler: CheckInHandler,
    private readonly checkoutHandler: CheckoutHandler,
  ) {}

  @Get()
  @Roles(...ALL_STAFF)
  findMany(
    @Query(new ZodValidationPipe(listReservationsQuerySchema)) query: ListReservationsQuery,
    @CurrentUser() actor: AuthUser,
  ): Promise<ReservationView[]> {
    return this.reservations.findMany(query, actor);
  }

  @Get(':id')
  @Roles(...ALL_STAFF)
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
  ): Promise<ReservationView> {
    return this.reservations.findOne(id, actor);
  }

  @Post()
  @Roles(...RECEPTIONIST_PLUS)
  create(
    @Body(new ZodValidationPipe(createReservationSchema)) dto: CreateReservationDto,
    @CurrentUser() actor: AuthUser,
    @Ctx() ctx: RequestContext,
  ): Promise<ReservationView> {
    return this.reservations.create(dto, actor, ctx);
  }

  /** Step 1: base payment, then the treatment starts. §8.2. */
  @Post(':id/check-in')
  @HttpCode(HttpStatus.OK)
  @Roles(...RECEPTIONIST_PLUS)
  @Idempotent()
  checkIn(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(checkInSchema)) dto: CheckInDto,
    @CurrentUser() actor: AuthUser,
    @Ctx() ctx: RequestContext,
  ): Promise<CheckInView> {
    return this.checkInHandler.checkIn(id, dto, actor, ctx);
  }

  /** Step 2: the tip, if there is one, and the booking closes. §8.3. */
  @Post(':id/checkout')
  @HttpCode(HttpStatus.OK)
  @Roles(...RECEPTIONIST_PLUS)
  @Idempotent()
  checkout(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(checkoutSchema)) dto: CheckoutDto,
    @CurrentUser() actor: AuthUser,
    @Ctx() ctx: RequestContext,
  ): Promise<CheckoutView> {
    return this.checkoutHandler.checkout(id, dto, actor, ctx);
  }

  /**
   * RECEPTIONIST+ at the door; the service raises it to MANAGER+ once the
   * booking is IN_PROGRESS, because by then the guest has already paid and the
   * guard cannot know the status at routing time. §6.4.
   */
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @Roles(...RECEPTIONIST_PLUS)
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(cancelReservationSchema)) dto: CancelReservationDto,
    @CurrentUser() actor: AuthUser,
    @Ctx() ctx: RequestContext,
  ): Promise<ReservationView> {
    return this.reservations.cancel(id, dto, actor, ctx);
  }

  /**
   * Move a booking. No availability pre-check: the update goes in and the
   * exclusion constraints decide, so a clash comes back as a 409 naming the
   * resource rather than a race nobody noticed. §5.5.
   */
  @Patch(':id')
  @Roles(...RECEPTIONIST_PLUS)
  reschedule(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(rescheduleReservationSchema)) dto: RescheduleReservationDto,
    @CurrentUser() actor: AuthUser,
    @Ctx() ctx: RequestContext,
  ): Promise<ReservationView> {
    return this.reservations.reschedule(id, dto, actor, ctx);
  }

  @Post(':id/no-show')
  @HttpCode(HttpStatus.OK)
  @Roles(...RECEPTIONIST_PLUS)
  markNoShow(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @Ctx() ctx: RequestContext,
  ): Promise<ReservationView> {
    return this.reservations.markNoShow(id, actor, ctx);
  }
}
