import { Controller, Get, HttpStatus, Logger, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { RedirectQuery, redirectQuerySchema } from '@berelax/contracts';
import { Public } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import type { Env } from '../config/env';
import { OutboundClicksService, sanitiseWhatsappText } from './outbound-clicks.service';
import { PublicThrottlerGuard } from './public-throttler.guard';
import { VISITOR_COOKIE } from './public.service';

/**
 * First-party click-out redirects. §10.4.
 *
 * `<a href="https://api.berelax.ae/v1/r/wa?ctx=hero&text=...">` instead of a
 * bare `wa.me` link, so the one thing a WhatsApp-first business could never see
 * — how many people left the site for WhatsApp, and from where — becomes a row
 * in `outbound_clicks`.
 *
 * THE REDIRECT NEVER WAITS ON THE LOG. Every guest who taps the WhatsApp button
 * is a guest in the middle of deciding to book; if the database is slow, or
 * down, they go to WhatsApp anyway and the analytics are what is lost. The write
 * is fired, the failure is warned about, and the 302 goes out regardless.
 */
@Controller('r')
@Public()
@UseGuards(PublicThrottlerGuard)
// Spec §12.4: 60 a minute per IP on the redirects. The hourly window is set
// well above it because a guest bouncing between the site's WhatsApp buttons is
// ordinary behaviour, not abuse.
@Throttle({
  publicMinute: { limit: 60, ttl: 60_000 },
  publicHour: { limit: 600, ttl: 60 * 60_000 },
})
export class RedirectController {
  private readonly logger = new Logger(RedirectController.name);
  /** Digits only, which is the form `wa.me/<number>` wants. */
  private readonly whatsappNumber: string;

  constructor(
    private readonly clicks: OutboundClicksService,
    config: ConfigService<Env, true>,
  ) {
    this.whatsappNumber = String(config.get('WHATSAPP_NUMBER', { infer: true })).replace(/\D/g, '');
  }

  @Get('wa')
  whatsapp(
    @Query(new ZodValidationPipe(redirectQuerySchema)) query: RedirectQuery,
    @Req() req: Request,
    @Res() res: Response,
  ): void {
    this.log('whatsapp', query, req);

    const text = sanitiseWhatsappText(query.text);
    const suffix = text ? `?text=${encodeURIComponent(text)}` : '';
    res.redirect(HttpStatus.FOUND, `https://wa.me/${this.whatsappNumber}${suffix}`);
  }

  /**
   * The phone buttons. The number comes from configuration rather than from the
   * branch row on purpose: a redirect must not wait on a query, and §12.5 ships
   * exactly one public number because the spa's advertised mobile and its
   * WhatsApp line are the same handset. On the day they differ, add
   * `PHONE_NUMBER` to `env.ts` — do not put a lookup on this path.
   */
  @Get('call')
  call(
    @Query(new ZodValidationPipe(redirectQuerySchema)) query: RedirectQuery,
    @Req() req: Request,
    @Res() res: Response,
  ): void {
    this.log('call', query, req);

    res.redirect(HttpStatus.FOUND, `tel:+${this.whatsappNumber}`);
  }

  /**
   * Fire the write, do not await it, and swallow whatever comes back. The
   * `void` is deliberate and so is the `.catch`: an unhandled rejection here
   * would take the process down for a missed analytics row.
   */
  private log(target: 'whatsapp' | 'call', query: RedirectQuery, req: Request): void {
    void this.clicks
      .record({
        target,
        context: query.ctx ?? null,
        // The server-set mirror cookie, which is the only identifier that
        // survives Safari's seven-day cap on script storage. §10.5.
        visitorId: readVisitorCookie(req),
        landingPath: query.path ?? null,
        utmSource: query.utm_source ?? null,
        utmMedium: query.utm_medium ?? null,
        utmCampaign: query.utm_campaign ?? null,
        gclid: query.gclid ?? null,
        fbclid: query.fbclid ?? null,
        referrer: req.get('referer') ?? null,
        userAgent: req.get('user-agent') ?? null,
      })
      .catch((err: unknown) => {
        this.logger.warn(
          { err: err instanceof Error ? err.message : String(err), target },
          'outbound click not logged',
        );
      });
  }
}

/** `req.cookies` is untyped in @types/express; narrowed once, here. */
function readVisitorCookie(req: Request): string | null {
  const cookies = req.cookies as Record<string, string | undefined> | undefined;
  return cookies?.[VISITOR_COOKIE] ?? null;
}
