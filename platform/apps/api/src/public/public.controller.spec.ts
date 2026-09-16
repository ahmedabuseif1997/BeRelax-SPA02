import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { CookieOptions, Response } from 'express';
import type { AttributionPayload } from '@berelax/contracts';
import type { Env } from '../config/env';
import { PublicController } from './public.controller';
import { PublicService, VISITOR_COOKIE } from './public.service';

const VISITOR_ID = '0192d0d0-0000-7000-8000-000000000001';
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

function attributionFixture(): AttributionPayload {
  const touch = {
    ts: '2026-09-15T21:00:00+04:00',
    source: 'instagram',
    medium: 'paid_social',
    landing: '/pricing',
  };
  return {
    v: 1,
    visitorId: VISITOR_ID,
    first: touch,
    last: touch,
    touches: [touch],
    createdAt: '2026-09-15T21:00:00+04:00',
    updatedAt: '2026-09-15T21:00:00+04:00',
  };
}

function setup(options: { recordTouch?: jest.Mock; cookieDomain?: string } = {}) {
  const publicService = {
    menu: jest.fn().mockResolvedValue({ categories: [] }),
    createBookingRequest: jest.fn().mockResolvedValue({ ok: true, reference: 'BRX-ABCD-2345' }),
    recordTouch: options.recordTouch ?? jest.fn().mockResolvedValue(undefined),
  } as unknown as PublicService;

  const config = {
    get: () => options.cookieDomain ?? '.berelax.ae',
  } as unknown as ConfigService<Env, true>;

  return { publicService, controller: new PublicController(publicService, config) };
}

function responseFixture(): Response & { cookie: jest.Mock } {
  return { cookie: jest.fn() } as unknown as Response & { cookie: jest.Mock };
}

describe('PublicController', () => {
  describe('the brx_vid cookie mirror', () => {
    it('sets it exactly as §10.5 specifies', async () => {
      const { controller } = setup();
      const res = responseFixture();

      await controller.touch(attributionFixture(), res);

      const [name, value, options] = res.cookie.mock.calls[0]! as [
        string,
        string,
        CookieOptions,
      ];
      expect(name).toBe(VISITOR_COOKIE);
      expect(value).toBe(VISITOR_ID);
      expect(options).toEqual({
        // Safari's ITP caps SCRIPT-written storage at seven days. A cookie set
        // in a response header, first-party, is not subject to that cap — which
        // is the entire reason this cookie exists.
        httpOnly: true,
        secure: true,
        // 'lax' and not 'strict': the visitor arrives from Google or Instagram.
        sameSite: 'lax',
        domain: '.berelax.ae',
        path: '/',
        maxAge: NINETY_DAYS_MS,
      });
    });

    it('takes the domain from COOKIE_DOMAIN', async () => {
      const { controller } = setup({ cookieDomain: 'localhost' });
      const res = responseFixture();

      await controller.touch(attributionFixture(), res);

      const [, , options] = res.cookie.mock.calls[0]! as [string, string, CookieOptions];
      expect(options.domain).toBe('localhost');
    });

    it('sets the cookie even when the snapshot cannot be written', async () => {
      // The durable half of attribution must survive a database wobble: losing
      // one touch costs a row, losing the cookie costs ninety days of identity.
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const failing = jest.fn().mockRejectedValue(new Error('connection terminated'));
      const { controller } = setup({ recordTouch: failing });
      const res = responseFixture();

      try {
        await expect(controller.touch(attributionFixture(), res)).resolves.toBeUndefined();

        expect(res.cookie).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });

    it('persists the touch', async () => {
      const { controller, publicService } = setup();

      await controller.touch(attributionFixture(), responseFixture());

      expect(publicService.recordTouch).toHaveBeenCalledWith(
        expect.objectContaining({ visitorId: VISITOR_ID }),
      );
    });
  });

  describe('the form and the menu', () => {
    it('returns only ok and a reference from the booking form', async () => {
      const { controller } = setup();

      const receipt = await controller.create({
        guestName: 'Amira Khan',
        guestPhone: '+971501234567',
      });

      expect(receipt).toEqual({ ok: true, reference: 'BRX-ABCD-2345' });
    });

    it('hands the menu straight back', async () => {
      const { controller, publicService } = setup();

      await controller.menu();

      expect(publicService.menu).toHaveBeenCalledTimes(1);
    });
  });
});
