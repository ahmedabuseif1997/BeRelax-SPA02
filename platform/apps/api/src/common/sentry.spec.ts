/**
 * `@sentry/node` is not installed, so `initSentry` reports nothing. `scrubEvent`
 * is still the part that has to be right: it is the `beforeSend` §12.3 requires,
 * and the day somebody installs the SDK it is the only thing standing between a
 * guest's phone number and a third party's error tracker in another jurisdiction
 * (§11.7).
 */

import { initSentry, scrubBreadcrumb, scrubEvent } from './sentry';
import type { SentryEvent } from './sentry';
import { REDACTION_CENSOR } from './pii';

const PHONE = '+971501234567';
const NAME = 'Layla Al Mansouri';
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.realLookingToken.sig';

describe('sentry beforeSend', () => {
  function event(): SentryEvent {
    return {
      message: `booking failed for guestPhone: ${PHONE}`,
      request: {
        url: `https://api.berelax.ae/v1/guests?phone=${PHONE}`,
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, cookie: 'session=deadbeef' },
        cookies: { session: 'deadbeef' },
        data: { fullName: NAME, phone: PHONE },
      },
      user: { id: 'user-1', role: 'RECEPTIONIST', email: 'staff@berelax.ae', fullName: NAME },
      extra: { reservation: { id: '0192f8c1', guest: { guestPhone: PHONE } } },
      contexts: { branch: { id: 'branch-1', legalName: NAME } },
      breadcrumbs: [
        { message: `POST /v1/guests phone: ${PHONE}`, data: { passwordHash: 'hash', ok: true } },
      ],
    };
  }

  it('drops the body, the headers, the cookies and the query string', () => {
    const scrubbed = scrubEvent(event());
    const serialised = JSON.stringify(scrubbed);

    expect(serialised).not.toContain(PHONE);
    expect(serialised).not.toContain(NAME);
    expect(serialised).not.toContain(TOKEN);
    expect(serialised).not.toContain('deadbeef');

    expect(scrubbed.request).toEqual({ url: 'https://api.berelax.ae/v1/guests', method: 'POST' });
  });

  it('keeps what makes the report worth having', () => {
    const scrubbed = scrubEvent(event());
    expect(scrubbed.user?.id).toBe('user-1');
    expect(scrubbed.user?.role).toBe('RECEPTIONIST');
    expect((scrubbed.extra?.reservation as { id: string }).id).toBe('0192f8c1');
    expect(scrubbed.contexts?.branch?.id).toBe('branch-1');
  });

  it('strips PII from breadcrumbs, which §12.3 names outright', () => {
    const crumb = scrubBreadcrumb({
      message: `lookup guestPhone: ${PHONE}`,
      data: { email: 'guest@example.ae', statusCode: 404 },
    });
    expect(crumb.message).not.toContain(PHONE);
    expect(crumb.data?.email).toBe(REDACTION_CENSOR);
    expect(crumb.data?.statusCode).toBe(404);
  });
});

describe('initSentry', () => {
  it('does nothing, quietly, when no DSN is configured', () => {
    const warn = jest.fn();
    expect(initSentry({ dsn: undefined, environment: 'test', warn })).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('says so loudly when a DSN is configured and the SDK is not installed', () => {
    // Otherwise the first anyone learns that nothing was ever reporting is
    // during the incident they expected to be paged about.
    const warn = jest.fn();
    expect(initSentry({ dsn: 'https://key@sentry.io/1', environment: 'production', warn })).toBe(
      false,
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('@sentry/node is not installed'));
  });
});
