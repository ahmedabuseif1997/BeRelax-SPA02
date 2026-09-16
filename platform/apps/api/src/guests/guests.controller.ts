import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  CreateGuestConsentDto,
  CreateGuestDto,
  UpdateGuestDto,
  UserRole,
  createGuestConsentSchema,
  createGuestSchema,
  updateGuestSchema,
} from '@berelax/contracts';
import { Ctx, CurrentUser, Roles } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import type { AuthUser, RequestContext } from '../common/request-context';
import {
  GuestConsentView,
  GuestDetailView,
  GuestView,
  GuestsService,
  ListGuestsQuery,
  listGuestsQuerySchema,
} from './guests.service';

/** §7.3: the guest book is reception's. §7.5 puts consent capture at the same desk. */
const RECEPTIONIST_PLUS = [UserRole.OWNER, UserRole.MANAGER, UserRole.RECEPTIONIST] as const;

@Controller('guests')
@Roles(...RECEPTIONIST_PLUS)
export class GuestsController {
  constructor(private readonly guests: GuestsService) {}

  @Get()
  findMany(
    @Query(new ZodValidationPipe(listGuestsQuerySchema)) query: ListGuestsQuery,
    @CurrentUser() actor: AuthUser,
  ): Promise<GuestView[]> {
    return this.guests.findMany(query, actor);
  }

  @Get(':id')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
  ): Promise<GuestDetailView> {
    return this.guests.findOne(id, actor);
  }

  @Post()
  create(
    @Body(new ZodValidationPipe(createGuestSchema)) dto: CreateGuestDto,
    @CurrentUser() actor: AuthUser,
  ): Promise<GuestView> {
    return this.guests.create(dto, actor);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateGuestSchema)) dto: UpdateGuestDto,
    @CurrentUser() actor: AuthUser,
  ): Promise<GuestView> {
    return this.guests.update(id, dto, actor);
  }

  /** Not a delete. The visits and the money stay; only the welcome is withdrawn. */
  @Post(':id/block')
  @HttpCode(HttpStatus.OK)
  block(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
  ): Promise<GuestView> {
    return this.guests.setBlocked(id, true, actor);
  }

  @Post(':id/unblock')
  @HttpCode(HttpStatus.OK)
  unblock(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
  ): Promise<GuestView> {
    return this.guests.setBlocked(id, false, actor);
  }

  /** §7.5. The IP is taken from the request context, never from the body. */
  @Post(':id/consents')
  @HttpCode(HttpStatus.CREATED)
  recordConsent(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(createGuestConsentSchema)) dto: CreateGuestConsentDto,
    @CurrentUser() actor: AuthUser,
    @Ctx() ctx: RequestContext,
  ): Promise<GuestConsentView> {
    return this.guests.recordConsent(id, dto, actor, ctx);
  }
}
