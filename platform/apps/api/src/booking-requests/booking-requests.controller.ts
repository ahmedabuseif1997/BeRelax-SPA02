import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ConvertBookingRequestDto,
  ListBookingRequestsQuery,
  UserRole,
  convertBookingRequestSchema,
  listBookingRequestsQuerySchema,
} from '@berelax/contracts';
import { Ctx, CurrentUser, Roles } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import type { AuthUser, RequestContext } from '../common/request-context';
import {
  BookingRequestView,
  BookingRequestsService,
  ConvertedBookingRequestView,
} from './booking-requests.service';

/** The inbox is reception's job. A therapist has no business in it. §6.4, §7.3. */
const RECEPTIONIST_PLUS = [UserRole.OWNER, UserRole.MANAGER, UserRole.RECEPTIONIST] as const;

@Controller('booking-requests')
@Roles(...RECEPTIONIST_PLUS)
export class BookingRequestsController {
  constructor(private readonly requests: BookingRequestsService) {}

  @Get()
  findMany(
    @Query(new ZodValidationPipe(listBookingRequestsQuerySchema)) query: ListBookingRequestsQuery,
    @CurrentUser() actor: AuthUser,
  ): Promise<BookingRequestView[]> {
    return this.requests.findMany(query, actor);
  }

  @Get(':id')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
  ): Promise<BookingRequestView> {
    return this.requests.findOne(id, actor);
  }

  /**
   * NOT marked `@Idempotent()`. A conversion takes no money — the base cost is
   * collected at check-in, hours later (§8.1) — and a double-tap is already
   * answered: the second call finds the request CONVERTED and gets a 409 rather
   * than a second booking. The idempotency interceptor exists for the two
   * endpoints where a replay would charge a guest twice. §7.6.
   */
  @Post(':id/convert')
  @HttpCode(HttpStatus.CREATED)
  convert(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(convertBookingRequestSchema)) dto: ConvertBookingRequestDto,
    @CurrentUser() actor: AuthUser,
    @Ctx() ctx: RequestContext,
  ): Promise<ConvertedBookingRequestView> {
    return this.requests.convert(id, dto, actor, ctx);
  }

  /** No body: the table has nowhere to keep a reason. See the note in `schemas.ts`. */
  @Post(':id/decline')
  @HttpCode(HttpStatus.OK)
  decline(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
  ): Promise<BookingRequestView> {
    return this.requests.decline(id, actor);
  }

  @Post(':id/spam')
  @HttpCode(HttpStatus.OK)
  markSpam(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
  ): Promise<BookingRequestView> {
    return this.requests.markSpam(id, actor);
  }
}
