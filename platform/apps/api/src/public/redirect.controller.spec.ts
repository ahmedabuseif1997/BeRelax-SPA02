import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import type { RedirectQuery } from '@berelax/contracts';
import type { Env } from '../config/env';
import type { PrismaService } from '../prisma/prisma.service';
import {
  MAX_WHATSAPP_TEXT,
  OutboundClicksService,
  sanitiseWhatsappText,
} from './outbound-clicks.service';
import { RedirectController } from './redirect.controller';

const VISITOR_ID = '0192d0d0-0000-7000-8000-000000000001';
const NUMBER = '971525108633';

/** Built rather than typed, so the source file stays free of invisible characters. */
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);
const RTL_OVERRIDE = String.fromCharCode(0x202e);
const NUL = String.fromCharCode(0);

function setup(options: { record?: jest.Mock } = {}) {
  const record = options.record ?? jest.fn().mockResolvedValue(undefined);
  const clicks = { record } as unknown as OutboundClicksService;
  // Spaces and a leading + on purpose: wa.me wants digits and tel: wants a plus.
  const config = { get: () => '+971 52 510 8633' } as unknown as ConfigService<Env, true>;

  return { record, controller: new RedirectController(clicks, config) };
}

function requestFixture(overrides: { cookies?: Record<string, string> } = {}): Request {
  const headers: Record<string, string> = {
    referer: 'https://berelax.ae/pricing',
    'user-agent': 'Mozilla/5.0 (iPhone)',
  };
  return {
    cookies: overrides.cookies ?? { brx_vid: VISITOR_ID },
    get: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
}

function responseFixture(): Response & { redirect: jest.Mock } {
  return { redirect: jest.fn() } as unknown as Response & { redirect: jest.Mock };
}

const QUERY: RedirectQuery = {
  ctx: 'hero',
  utm_source: 'google',
  utm_medium: 'cpc',
  utm_campaign: 'ramadan-offers',
  gclid: 'Cj0KCQ',
  path: '/pricing',
};

describe('RedirectController', () => {
  describe('/r/wa', () => {
    it('302s to wa.me with the number reduced to digits', () => {
      const { controller } = setup();
      const res = responseFixture();

      controller.whatsapp({}, requestFixture(), res);

      expect(res.redirect).toHaveBeenCalledWith(302, `https://wa.me/${NUMBER}`);
    });

    it('carries a pre-composed message through, url-encoded', () => {
      const message = 'Hi, I would like to book a 60 minute massage';
      const { controller } = setup();
      const res = responseFixture();

      controller.whatsapp({ text: message }, requestFixture(), res);

      expect(res.redirect).toHaveBeenCalledWith(
        302,
        `https://wa.me/${NUMBER}?text=${encodeURIComponent(message)}`,
      );
    });

    it('drops a message that is really a link, and still redirects', () => {
      const { controller } = setup();
      const res = responseFixture();

      controller.whatsapp(
        { text: 'Claim your prize at http://evil.example' },
        requestFixture(),
        res,
      );

      expect(res.redirect).toHaveBeenCalledWith(302, `https://wa.me/${NUMBER}`);
    });

    it('logs the click with everything the channel report needs', () => {
      const { controller, record } = setup();

      controller.whatsapp(QUERY, requestFixture(), responseFixture());

      expect(record).toHaveBeenCalledWith({
        target: 'whatsapp',
        context: 'hero',
        visitorId: VISITOR_ID,
        landingPath: '/pricing',
        utmSource: 'google',
        utmMedium: 'cpc',
        utmCampaign: 'ramadan-offers',
        gclid: 'Cj0KCQ',
        fbclid: null,
        referrer: 'https://berelax.ae/pricing',
        userAgent: 'Mozilla/5.0 (iPhone)',
      });
    });

    it('records no visitor when the mirror cookie is absent', () => {
      const { controller, record } = setup();

      controller.whatsapp(QUERY, requestFixture({ cookies: {} }), responseFixture());

      expect(record.mock.calls[0]![0]).toMatchObject({ visitorId: null });
    });
  });

  describe('the redirect never waits on the log', () => {
    it('sends the 302 while the write is still in flight', () => {
      // The guest is mid-decision. If the database is slow they go to WhatsApp
      // anyway, and the analytics are what is lost. §10.4.
      const pending = jest.fn().mockReturnValue(new Promise<void>(() => undefined));
      const { controller } = setup({ record: pending });
      const res = responseFixture();

      controller.whatsapp(QUERY, requestFixture(), res);

      expect(res.redirect).toHaveBeenCalledTimes(1);
    });

    it('redirects and warns when the write fails, rather than failing the request', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const failing = jest.fn().mockRejectedValue(new Error('connection terminated'));
      const { controller } = setup({ record: failing });
      const res = responseFixture();

      try {
        controller.whatsapp(QUERY, requestFixture(), res);
        // Let the rejection settle: an unhandled one would take the process down.
        await Promise.resolve();
        await Promise.resolve();

        expect(res.redirect).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({ target: 'whatsapp' }),
          'outbound click not logged',
        );
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe('/r/call', () => {
    it('302s to a tel: URI and logs the click under its own target', () => {
      const { controller, record } = setup();
      const res = responseFixture();

      controller.call(QUERY, requestFixture(), res);

      expect(res.redirect).toHaveBeenCalledWith(302, `tel:+${NUMBER}`);
      expect(record.mock.calls[0]![0]).toMatchObject({ target: 'call' });
    });
  });
});

describe('sanitiseWhatsappText', () => {
  it('passes an ordinary message through untouched', () => {
    expect(sanitiseWhatsappText('Hi, I would like to book for two people at 8pm.')).toBe(
      'Hi, I would like to book for two people at 8pm.',
    );
  });

  it('keeps Arabic, which is half of what this spa is written to', () => {
    const arabic = 'مرحبا، أريد حجز موعد';

    expect(sanitiseWhatsappText(arabic)).toBe(arabic);
  });

  it('turns newlines and tabs into single spaces instead of running words together', () => {
    expect(sanitiseWhatsappText('Hi\nthere\t\tfriend')).toBe('Hi there friend');
  });

  it('removes zero-width and bidi-override characters', () => {
    // A right-to-left override makes a string render as something other than
    // what it says, which is exactly how you would disguise a link.
    const disguised = `book${ZERO_WIDTH_SPACE}now${RTL_OVERRIDE}please`;

    expect(sanitiseWhatsappText(disguised)).toBe('book now please');
  });

  it.each([
    'Visit http://evil.example for a free massage',
    'see https://berelax.ae.evil.example',
    'go to www.evil.example now',
    'details at evil.com',
    'chat on wa.me/971000000000',
  ])('refuses "%s" outright, because a trimmed link is still a link', (text) => {
    expect(sanitiseWhatsappText(text)).toBeNull();
  });

  it('strips the characters a message only needs if it is not a message', () => {
    expect(sanitiseWhatsappText('book <b>now</b> pay=0 {x}')).toBe('book b now b pay 0 x');
  });

  it.each([undefined, '', '   '])('returns null for %p', (text) => {
    expect(sanitiseWhatsappText(text)).toBeNull();
  });

  it('returns null for a string that is nothing but control characters', () => {
    expect(sanitiseWhatsappText(NUL + NUL)).toBeNull();
  });

  it('trims a long message on a word boundary rather than rejecting it', () => {
    // A guest tapping a button in a two-year-old advert gets a working button.
    const long = `${'massage '.repeat(60)}please`;

    const result = sanitiseWhatsappText(long)!;

    expect(result.length).toBeLessThanOrEqual(MAX_WHATSAPP_TEXT);
    expect(result.endsWith('massage')).toBe(true);
  });
});

describe('OutboundClicksService', () => {
  function clickSetup() {
    const prisma = {
      outboundClick: { create: jest.fn().mockResolvedValue({}) },
    } as unknown as PrismaService;
    return { prisma, service: new OutboundClicksService(prisma) };
  }

  it('writes the row the channel report joins on', async () => {
    const { service, prisma } = clickSetup();

    await service.record({ target: 'whatsapp', context: 'hero', visitorId: VISITOR_ID });

    const { data } = (prisma.outboundClick.create as jest.Mock).mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(data).toMatchObject({ target: 'whatsapp', context: 'hero', visitorId: VISITOR_ID });
  });

  it('discards a forged visitor cookie rather than letting the uuid column throw', async () => {
    const { service, prisma } = clickSetup();

    await service.record({ target: 'whatsapp', visitorId: 'not-a-uuid' });

    const { data } = (prisma.outboundClick.create as jest.Mock).mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(data.visitorId).toBeNull();
  });

  it('caps the user agent, which is attacker-controlled and unbounded', async () => {
    const { service, prisma } = clickSetup();

    await service.record({ target: 'call', userAgent: 'x'.repeat(5_000) });

    const { data } = (prisma.outboundClick.create as jest.Mock).mock.calls[0]![0] as {
      data: { userAgent: string };
    };
    expect(data.userAgent).toHaveLength(300);
  });
});
