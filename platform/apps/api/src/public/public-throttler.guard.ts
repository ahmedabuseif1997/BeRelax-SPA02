import { Injectable, OnModuleInit } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerOptions } from '@nestjs/throttler';
import type { Request } from 'express';

/**
 * Two rate-limit windows for the routes an anonymous caller can reach. §12.4.
 *
 * The root module registers a single throttler — 300 requests a minute, keyed
 * per user — which is the right shape for reception's iPads and the wrong shape
 * entirely for a public form. A burst limit alone lets a script post nine
 * enquiries a minute all night; an hourly limit alone lets it post sixty in one
 * second. Both windows have to hold.
 *
 * These are the defaults; the routes restate them with `@Throttle`, which is
 * where anyone looking for the numbers will look. @nestjs/throttler only
 * evaluates windows it has been told about, and `@Throttle` can only override a
 * window that already exists — which is the whole reason this class is here.
 */
export const PUBLIC_THROTTLERS: readonly ThrottlerOptions[] = [
  { name: 'publicMinute', ttl: 60_000, limit: 10 },
  { name: 'publicHour', ttl: 60 * 60_000, limit: 60 },
];

@Injectable()
export class PublicThrottlerGuard extends ThrottlerGuard implements OnModuleInit {
  /**
   * Deliberately no constructor. `ThrottlerGuard`'s own is decorated with the
   * injection tokens for its options and its storage, and redeclaring it here
   * means restating that metadata correctly — which is one subtle mistake away
   * from a guard holding something that is not a Reflector and failing on the
   * first public request rather than at boot. Inheriting the constructor
   * untouched and swapping the windows afterwards has no such edge.
   *
   * The storage is shared with the global guard; only the windows differ.
   */
  async onModuleInit(): Promise<void> {
    await super.onModuleInit();
    this.throttlers = PUBLIC_THROTTLERS.map((throttler) => ({ ...throttler }));
  }

  /**
   * Per IP, because an unauthenticated caller has no other identity — and,
   * unlike the front desk behind one NAT address, no reason to be counted as a
   * group. `trust proxy` is set in main.ts, so `req.ip` is the client and not
   * Cloudflare.
   */
  protected async getTracker(req: Request): Promise<string> {
    return `ip:${req.ip ?? req.socket.remoteAddress ?? 'unknown'}`;
  }
}
