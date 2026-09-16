import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import type { CookieOptions, Request, Response } from 'express';
import { ErrorCode } from '@berelax/contracts';
import { Ctx, CurrentUser, Public } from '../common/decorators';
import type { AuthUser, RequestContext } from '../common/request-context';
import type { Env } from '../config/env';
import { AuthService } from './auth.service';
import type { AuthSession } from './auth.service';
import { AllowPasswordChange } from './jwt-auth.guard';
import { changePasswordBodyPipe, loginBodyPipe } from './dto';
import type { ChangePasswordDto, LoginDto } from './dto';

/** §6.2: the refresh token is a cookie the dashboard's JavaScript never sees. */
export const REFRESH_COOKIE = 'brx_rt';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SessionResponse {
  /** Held in memory by the dashboard — never localStorage. Spec §6.2. */
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  mustChangePassword: boolean;
  user: AuthUser;
}

@Controller('auth')
export class AuthController {
  private readonly isProduction: boolean;
  private readonly cookieDomain: string;
  private readonly refreshTtlDays: number;

  constructor(
    private readonly auth: AuthService,
    config: ConfigService<Env, true>,
  ) {
    this.isProduction = config.get('NODE_ENV', { infer: true }) === 'production';
    this.cookieDomain = String(config.get('COOKIE_DOMAIN', { infer: true }) ?? 'localhost');
    this.refreshTtlDays = Number(config.get('JWT_REFRESH_TTL_DAYS', { infer: true })) || 7;
  }

  /** Spec §12.4 rate limits: five attempts per quarter of an hour. */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 15 * 60 * 1000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body(loginBodyPipe) dto: LoginDto,
    @Ctx() ctx: RequestContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionResponse> {
    return this.respond(await this.auth.login(dto, ctx), res);
  }

  /** Public because the access token it replaces has, by definition, expired. */
  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() req: Request,
    @Ctx() ctx: RequestContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionResponse> {
    const presented = readRefreshCookie(req);
    if (!presented) {
      throw new UnauthorizedException({
        error: { code: ErrorCode.INVALID_REFRESH_TOKEN, message: 'Sign in again.' },
      });
    }
    return this.respond(await this.auth.refresh(presented, ctx), res);
  }

  /**
   * The cookie is the credential being revoked, so this does not need — and must
   * not require — a live access token: a user who still has to change their
   * password, or whose access token has run out, has to be able to sign out.
   */
  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @Req() req: Request,
    @Ctx() ctx: RequestContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.logout(readRefreshCookie(req), ctx);
    res.clearCookie(REFRESH_COOKIE, this.cookieOptions());
  }

  /** The one route JwtAuthGuard lets through while `mustChangePassword` is set. */
  @AllowPasswordChange()
  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  async changePassword(
    @Body(changePasswordBodyPipe) dto: ChangePasswordDto,
    @CurrentUser() user: AuthUser,
    @Ctx() ctx: RequestContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionResponse> {
    return this.respond(await this.auth.changePassword(user, dto, ctx), res);
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser): { user: AuthUser } {
    return { user };
  }

  private respond(session: AuthSession, res: Response): SessionResponse {
    res.cookie(REFRESH_COOKIE, session.refreshToken, this.cookieOptions());
    return {
      accessToken: session.accessToken,
      tokenType: 'Bearer',
      expiresIn: session.expiresIn,
      mustChangePassword: session.mustChangePassword,
      user: session.user,
    };
  }

  private cookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      // Local development is plain http, where a Secure cookie is simply never sent.
      secure: this.isProduction,
      sameSite: 'strict',
      domain: this.cookieDomain,
      // Root path, not '/auth': the global prefix (`/v1`) is set in main.ts and a
      // path that does not match it would silently stop the cookie being sent.
      path: '/',
      maxAge: this.refreshTtlDays * DAY_MS,
    };
  }
}

function readRefreshCookie(req: Request): string | undefined {
  // `req.cookies` is untyped in @types/express; narrowed once here.
  const cookies = req.cookies as Record<string, string | undefined> | undefined;
  return cookies?.[REFRESH_COOKIE];
}
