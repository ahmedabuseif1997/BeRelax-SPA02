import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import type { CookieOptions, Response } from 'express';
import {
  AttributionPayload,
  PublicBookingRequestDto,
  attributionSchema,
  publicBookingRequestSchema,
} from '@berelax/contracts';
import { Public } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import type { Env } from '../config/env';
import {
  ATTRIBUTION_WINDOW_DAYS,
  PublicBookingReceipt,
  PublicMenuView,
  PublicService,
  VISITOR_COOKIE,
} from './public.service';
import { PublicThrottlerGuard } from './public-throttler.guard';

const DAY_MS = 24 * 60 * 60 * 1000;

@Controller('public')
// Every route here is reachable without a token: this is the website talking.
@Public()
@UseGuards(PublicThrottlerGuard)
// Spec §12.4: 10 per minute and 60 per hour, per IP. Both windows must hold.
@Throttle({
  publicMinute: { limit: 10, ttl: 60_000 },
  publicHour: { limit: 60, ttl: 60 * 60_000 },
})
export class PublicController {
  private readonly logger = new Logger(PublicController.name);
  private readonly cookieDomain: string;

  constructor(
    private readonly publicService: PublicService,
    config: ConfigService<Env, true>,
  ) {
    this.cookieDomain = String(config.get('COOKIE_DOMAIN', { infer: true }) ?? 'localhost');
  }

  /** The live menu. The website's pricing section renders from this, not from markup. */
  @Get('services')
  menu(): Promise<PublicMenuView> {
    return this.publicService.menu();
  }

  /**
   * The website booking form. Creates an enquiry, never a booking: nothing here
   * holds a therapist, a room or a minute of anybody's evening. §1.1.
   */
  @Post('booking-requests')
  @HttpCode(HttpStatus.CREATED)
  create(
    @Body(new ZodValidationPipe(publicBookingRequestSchema)) dto: PublicBookingRequestDto,
  ): Promise<PublicBookingReceipt> {
    return this.publicService.createBookingRequest(dto);
  }

  /**
   * The attribution beacon. 204 and nothing else — `attribution.js` sends this
   * with `navigator.sendBeacon` on page unload and never reads a reply.
   */
  @Post('attribution/touch')
  @HttpCode(HttpStatus.NO_CONTENT)
  async touch(
    @Body(new ZodValidationPipe(attributionSchema)) payload: AttributionPayload,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    // The cookie is set FIRST and unconditionally. It is the durable half of
    // attribution (see below); a database hiccup may cost one touch, but it must
    // not cost the visitor's identity for the next ninety days.
    this.setVisitorCookie(res, payload.visitorId);

    try {
      await this.publicService.recordTouch(payload);
    } catch (err) {
      // A beacon that 500s is a beacon that gets retried in a loop by a browser
      // nobody is watching. Warn and return the 204.
      this.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'attribution touch not persisted',
      );
    }
  }

  /**
   * The cookie mirror. §10.5.
   *
   * A 90-day localStorage window is NOT achievable on Safari or on any iOS
   * browser. Intelligent Tracking Prevention caps script-writable storage —
   * localStorage, sessionStorage, IndexedDB and anything set through
   * `document.cookie` — at seven days of no interaction. Given how much of Abu
   * Dhabi's traffic is iPhone, relying on the script's own storage would
   * quietly halve the attribution window for most guests, and nothing would
   * look wrong until a campaign report did.
   *
   * ITP's cap applies to storage written by SCRIPT. A cookie written by the
   * server, in an HTTP response header, on a first-party domain, is not subject
   * to it. So localStorage is the fast path and this is the durable one: when
   * the script's copy has been evicted but the cookie survived, the server
   * recognises the visitor and picks the chain back up from the snapshots it
   * already holds.
   *
   * This only works while the API is a SUBDOMAIN of the site — api.berelax.ae
   * beside berelax.ae. On a separate domain the cookie is third-party and is
   * blocked outright, which is why COOKIE_DOMAIN refusing its localhost default
   * in production is a boot check and not a warning.
   */
  private setVisitorCookie(res: Response, visitorId: string): void {
    const options: CookieOptions = {
      // The visitor id is not the script's to read back; it already has its own
      // copy, and httpOnly keeps this one out of reach of anything injected.
      httpOnly: true,
      // Per §10.5, unconditionally. In local development over plain http the
      // browser will simply not store it — which is correct: an attribution
      // cookie that travelled in clear text is one a café network can read.
      secure: true,
      // 'lax' and not 'strict': the visitor arrives from Google or Instagram,
      // so a cookie withheld on cross-site navigation is a cookie that is never
      // sent on the one request that matters.
      sameSite: 'lax',
      domain: this.cookieDomain,
      // Root, not '/public': the global prefix is '/v1' and a path that does not
      // match it would silently stop the cookie coming back.
      path: '/',
      maxAge: ATTRIBUTION_WINDOW_DAYS * DAY_MS,
    };
    res.cookie(VISITOR_COOKIE, visitorId, options);
  }
}
