import { Module } from '@nestjs/common';
import { OutboundClicksService } from './outbound-clicks.service';
import { PublicController } from './public.controller';
import { PublicThrottlerGuard } from './public-throttler.guard';
import { PublicService } from './public.service';
import { RedirectController } from './redirect.controller';

/**
 * Everything an anonymous caller can reach: the menu, the booking form, the
 * attribution beacon and the two click-out redirects. §7.1.
 *
 * `PublicThrottlerGuard` is a provider rather than an APP_GUARD so the tighter
 * public windows apply here and nowhere else — reception must not be counted
 * against a ten-a-minute budget. §12.4.
 *
 * It imports neither ReservationsModule nor BookingRequestsModule: a public
 * caller creates an ENQUIRY, and an enquiry holds nothing. The only thing
 * shared with the inbox is `publicReference`, a pure function, so the two
 * surfaces agree on what the guest was told to quote. §1.1.
 */
@Module({
  controllers: [PublicController, RedirectController],
  providers: [PublicService, OutboundClicksService, PublicThrottlerGuard],
  exports: [PublicService],
})
export class PublicModule {}
