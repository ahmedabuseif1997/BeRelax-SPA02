import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The click-out log behind `/r/wa` and `/r/call`.
 *
 * Most of this business converts through WhatsApp, and a bare `wa.me` link is a
 * dead end — the click leaves the site and nothing comes back. A first-party
 * redirect turns that into one row: how many people left for WhatsApp, from
 * which page, on which campaign, and — when the visitor carries a `brx_vid`
 * cookie — which of them later became a booking. §10.4.
 *
 * It is honest, partial attribution. It does not read WhatsApp and never will.
 */

export interface OutboundClickInput {
  target: 'whatsapp' | 'call';
  context?: string | null;
  visitorId?: string | null;
  landingPath?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  gclid?: string | null;
  fbclid?: string | null;
  referrer?: string | null;
  userAgent?: string | null;
}

/** `visitor_id` is a uuid column; a forged or truncated cookie must not throw. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class OutboundClicksService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: OutboundClickInput): Promise<void> {
    await this.prisma.outboundClick.create({
      data: {
        target: input.target,
        context: input.context ?? null,
        visitorId: input.visitorId && UUID.test(input.visitorId) ? input.visitorId : null,
        landingPath: input.landingPath ?? null,
        utmSource: input.utmSource ?? null,
        utmMedium: input.utmMedium ?? null,
        utmCampaign: input.utmCampaign ?? null,
        gclid: input.gclid ?? null,
        fbclid: input.fbclid ?? null,
        referrer: input.referrer ?? null,
        userAgent: input.userAgent?.slice(0, 300) ?? null,
      },
    });
  }
}

/** A pre-composed WhatsApp message longer than this is not a message. */
export const MAX_WHATSAPP_TEXT = 300;

/**
 * Control characters, and the invisible ones that matter more: zero-width
 * joiners and the bidi overrides that let a string render as something other
 * than what it says. Replaced with a space rather than deleted, so stripping a
 * newline does not run two words together.
 */
const CONTROL_OR_INVISIBLE =
  // Matching control characters IS the point here, so no-control-regex has
  // nothing useful to say about it.
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/**
 * Anything that could be a link. This is the reason the whole function exists:
 * `/r/wa?text=...` is a first-party berelax.ae URL that gets pasted into adverts
 * and shared on social media, so anyone can compose one. Without this, somebody
 * could hand out a link that opens WhatsApp with a message carrying THEIR url,
 * pre-written, apparently from the spa.
 */
const LOOKS_LIKE_A_LINK =
  /(https?|:\/\/|www\.|\.(?:com|net|org|ae|io|me|co|uk|ru|cn|xyz|top|link|info|biz|app)\b)/i;

/**
 * What survives: letters in any script — the spa's guests write in Arabic as
 * often as in English — digits, spaces and ordinary sentence punctuation. What
 * does not: slashes, angle brackets, backticks, braces, `@` and `=`, the
 * characters a message needs only if it is trying to be something other than a
 * message.
 */
const NOT_MESSAGE_LIKE = /[^\p{L}\p{N}\p{Zs}.,!?'"()&:;+\u2010-\u2015\u2026\u060C\u061F-]/gu;

/**
 * Turn a `text` query parameter into a message it is safe to pre-compose, or
 * null if it is not one.
 *
 * Trimmed rather than rejected on length: a guest tapping a WhatsApp button in
 * a two-year-old advert should get a working button, not a validation error.
 * Rejected outright on a link, because a trimmed link is still a link.
 */
export function sanitiseWhatsappText(raw: string | undefined): string | null {
  if (!raw) return null;

  const visible = raw.replace(CONTROL_OR_INVISIBLE, ' ');
  // Tested BEFORE the character filter: stripping the slashes out of a URL and
  // then asking whether it looks like one would answer no every time.
  if (LOOKS_LIKE_A_LINK.test(visible)) return null;

  const cleaned = visible.replace(NOT_MESSAGE_LIKE, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  if (cleaned.length <= MAX_WHATSAPP_TEXT) return cleaned;

  // Cut on a word boundary, so the guest is not handed half a word.
  const clipped = cleaned.slice(0, MAX_WHATSAPP_TEXT);
  const lastSpace = clipped.lastIndexOf(' ');
  return (lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped).trim();
}
