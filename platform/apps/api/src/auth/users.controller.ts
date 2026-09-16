import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ErrorCode, UserRole } from '@berelax/contracts';
import { Ctx, CurrentUser, Roles } from '../common/decorators';
import type { AuthUser, RequestContext } from '../common/request-context';
import { UsersService } from './users.service';
import type { CreatedUser } from './users.service';
import { createUserBodyPipe, updateUserBodyPipe } from './dto';
import type { CreateUserDto, PublicUser, UpdateUserDto } from './dto';

/** Keeps a malformed id on the §3.6 error shape instead of Nest's default body. */
const userIdParam = new ParseUUIDPipe({
  exceptionFactory: () =>
    new UnprocessableEntityException({
      error: {
        code: ErrorCode.VALIDATION_FAILED,
        message: 'That is not a valid user id.',
        details: { issues: [{ path: 'id', message: 'Expected a UUID.' }] },
      },
    }),
});

/** §6.4: creating and disabling logins is the owner's alone — not the manager's. */
@Controller('users')
@Roles(UserRole.OWNER)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @Body(createUserBodyPipe) dto: CreateUserDto,
    @CurrentUser() actor: AuthUser,
    @Ctx() ctx: RequestContext,
  ): Promise<CreatedUser> {
    return this.users.create(dto, actor, ctx);
  }

  @Patch(':id')
  update(
    @Param('id', userIdParam) id: string,
    @Body(updateUserBodyPipe) dto: UpdateUserDto,
    @CurrentUser() actor: AuthUser,
    @Ctx() ctx: RequestContext,
  ): Promise<PublicUser> {
    return this.users.update(id, dto, actor, ctx);
  }

  @Post(':id/reset-password')
  @HttpCode(HttpStatus.OK)
  resetPassword(
    @Param('id', userIdParam) id: string,
    @CurrentUser() actor: AuthUser,
    @Ctx() ctx: RequestContext,
  ): Promise<{ user: PublicUser; temporaryPassword: string }> {
    return this.users.resetPassword(id, actor, ctx);
  }

  /** Handler metadata overrides the controller's, widening this one to MANAGER. §7.2. */
  @Post(':id/revoke-sessions')
  @Roles(UserRole.OWNER, UserRole.MANAGER)
  @HttpCode(HttpStatus.OK)
  revokeSessions(
    @Param('id', userIdParam) id: string,
    @CurrentUser() actor: AuthUser,
    @Ctx() ctx: RequestContext,
  ): Promise<{ revoked: number }> {
    return this.users.revokeSessions(id, actor, ctx);
  }
}
