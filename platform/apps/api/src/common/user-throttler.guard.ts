import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';

/**
 * Rate-limit authenticated traffic per USER, not per IP.
 *
 * Reception's iPads all sit behind one NAT address, so an IP-keyed limit counts
 * the whole front desk as a single client and throttles the busiest night of
 * the week. The user is the thing worth limiting; the IP is only a fallback for
 * unauthenticated callers, where it is the only identity available.
 *
 * Spec §12.4: 300/min for authenticated endpoints.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Request): Promise<string> {
    if (req.user?.id) return `user:${req.user.id}`;
    const forwarded = req.header('x-forwarded-for');
    const ip = forwarded ? forwarded.split(',')[0]?.trim() : req.socket.remoteAddress;
    return `ip:${ip ?? 'unknown'}`;
  }
}
