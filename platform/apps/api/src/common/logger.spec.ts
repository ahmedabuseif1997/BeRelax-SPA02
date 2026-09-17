/**
 * The privacy notice tells guests their name, phone number and email are held
 * to run their booking and for nothing else. §11.9 lists data minimisation as a
 * control that "carries compliance weight", and §11.6 retains application logs
 * for ninety days. Put those together and a guest's phone number in a log line
 * is a copy of personal data, in a place with its own retention, that no
 * processing record accounts for.
 *
 * So this suite does not test that redaction is *configured*. It runs a request
 * carrying a real guest name, a real phone number and a real Authorization
 * header through the real logger and asserts those strings are not in the
 * bytes that come out.
 */

import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import pino from 'pino';
import { pinoHttp } from 'pino-http';

import {
  buildPinoHttpOptions,
  buildPinoOptions,
  pathOf,
  requestBindings,
  routeOf,
  serialiseError,
} from './logger';
import { PII_FIELDS, REDACTION_CENSOR, scrubPiiFromText } from './pii';
import { pickAuditFields } from './audit.service';

const ENV = { LOG_LEVEL: 'info' as const, NODE_ENV: 'test' };

/** Every string a guest would recognise as theirs. None may appear in a log. */
const SECRETS = {
  guestName: 'Layla Al Mansouri',
  guestPhone: '+971501234567',
  guestEmail: 'layla.almansouri@example.ae',
  bearer: 'eyJhbGciOiJIUzI1NiJ9.aVeryRealLookingAccessToken.sig',
  cookie: 'br_vid=0192f8c1-4d2e-7a11-9e3f-0242ac120002; session=deadbeef',
  passwordHash: '$2b$12$abcdefghijklmnopqrstuv',
};

function capture(): { stream: Writable; lines: () => string[]; raw: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return {
    stream,
    lines: () => chunks.join('').trim().split('\n').filter(Boolean),
    raw: () => chunks.join(''),
  };
}

function assertNothingLeaked(output: string): void {
  for (const [name, value] of Object.entries(SECRETS)) {
    expect({ [name]: output.includes(value) }).toEqual({ [name]: false });
  }
}

describe('log redaction', () => {
  it('keeps a guest object out of the line a service logs by hand', () => {
    const sink = capture();
    const logger = pino(buildPinoOptions(ENV), sink.stream);

    logger.info(
      {
        guest: {
          fullName: SECRETS.guestName,
          phone: SECRETS.guestPhone,
          email: SECRETS.guestEmail,
        },
        reservation: { id: '0192f8c1', guest: { guestPhone: SECRETS.guestPhone } },
        user: { passwordHash: SECRETS.passwordHash },
      },
      'checkout completed',
    );

    assertNothingLeaked(sink.raw());
    // What is left has to still be useful, or the redaction has eaten the log.
    expect(sink.raw()).toContain('checkout completed');
    expect(sink.raw()).toContain('0192f8c1');
    expect(sink.raw()).toContain(REDACTION_CENSOR);
  });

  it('redacts every field the audit log strips', () => {
    const sink = capture();
    const logger = pino(buildPinoOptions(ENV), sink.stream);
    const row = Object.fromEntries(PII_FIELDS.map((f) => [f, `LEAK_${f}`]));

    logger.info({ row, nested: { deeper: { ...row } } }, 'snapshot');

    for (const field of PII_FIELDS) {
      expect(sink.raw()).not.toContain(`LEAK_${field}`);
    }
    // The two consumers of PII_FIELDS agreeing is the point of the shared list.
    expect(Object.keys(pickAuditFields(row))).toEqual([]);
  });

  it('never emits an authorization header, a cookie or a request body', () => {
    const sink = capture();
    const logger = pino(buildPinoOptions(ENV), sink.stream);

    logger.warn(
      {
        req: {
          method: 'POST',
          url: `/v1/guests?phone=${SECRETS.guestPhone}`,
          headers: { authorization: `Bearer ${SECRETS.bearer}`, cookie: SECRETS.cookie },
          body: { guestName: SECRETS.guestName },
        },
      },
      'suspicious request',
    );

    assertNothingLeaked(sink.raw());
  });
});

/** Enough of an Express request or response for pino-http to drive. */
type Fake = EventEmitter & Record<string, unknown>;

describe('the request logger', () => {
  function fakeRequest(overrides: Record<string, unknown> = {}): Fake {
    return Object.assign(new EventEmitter(), {
      method: 'POST',
      url: `/v1/public/booking-requests?phone=${encodeURIComponent(SECRETS.guestPhone)}`,
      originalUrl: `/v1/public/booking-requests?phone=${encodeURIComponent(SECRETS.guestPhone)}`,
      baseUrl: '',
      headers: {
        host: 'api.berelax.ae',
        authorization: `Bearer ${SECRETS.bearer}`,
        cookie: SECRETS.cookie,
        'user-agent': 'jest',
        'x-forwarded-for': '203.0.113.9',
      },
      body: {
        guestName: SECRETS.guestName,
        guestPhone: SECRETS.guestPhone,
        guestEmail: SECRETS.guestEmail,
      },
      socket: { remoteAddress: '10.0.0.1' },
      ...overrides,
    }) as unknown as Fake;
  }

  function fakeResponse(statusCode = 201): Fake {
    return Object.assign(new EventEmitter(), {
      statusCode,
      // pino-http reads this to tell "request completed" from "request aborted".
      writableEnded: true,
      getHeader: () => undefined,
      setHeader: () => undefined,
    }) as unknown as Fake;
  }

  /**
   * Drives one whole request the way the server does: the middleware, then the
   * context that RequestContextInterceptor puts on the request, then the
   * response finishing.
   */
  function runRequest(req: Fake, res: Fake): { lines: () => string[]; raw: () => string } {
    const sink = capture();
    const middleware = pinoHttp(buildPinoHttpOptions(ENV), sink.stream);
    middleware(req as any, res as any);

    // What the guard and the interceptor have added by the time the handler runs.
    req.route = { path: '/booking-requests' };
    req.baseUrl = '/v1/public';
    req.ctx = {
      requestId: String(req.id),
      branchId: '0192aaaa-0000-7000-8000-000000000001',
      actorUserId: '0192bbbb-0000-7000-8000-000000000002',
      actorRole: 'RECEPTIONIST',
    };

    res.emit('finish');
    return sink;
  }

  it('logs the completed request with requestId and route, and no guest data', () => {
    const req = fakeRequest();
    const sink = runRequest(req, fakeResponse());

    const line = JSON.parse(sink.lines()[0]!) as Record<string, unknown>;
    expect(line.requestId).toBe(req.id);
    expect(line.route).toBe('/v1/public/booking-requests');
    expect(line.userId).toBe('0192bbbb-0000-7000-8000-000000000002');
    expect(line.role).toBe('RECEPTIONIST');
    expect(line.branchId).toBe('0192aaaa-0000-7000-8000-000000000001');
    expect(line.msg).toBe('request completed');

    assertNothingLeaked(sink.raw());
    // The query string went with it — `?phone=…` is guest input on the URL.
    expect(sink.raw()).not.toContain('?phone=');
    expect((line.req as Record<string, unknown>).path).toBe('/v1/public/booking-requests');
  });

  it('logs a 5xx at error level, because "5xx rate > 1%" is an alert (§12.3)', () => {
    const sink = runRequest(fakeRequest(), fakeResponse(500));
    const line = JSON.parse(sink.lines()[0]!) as { level: string };
    expect(line.level).toBe('error');
  });

  it('logs a 4xx at warn and a 2xx at info', () => {
    expect(
      (JSON.parse(runRequest(fakeRequest(), fakeResponse(422)).lines()[0]!) as { level: string })
        .level,
    ).toBe('warn');
    expect(
      (JSON.parse(runRequest(fakeRequest(), fakeResponse(200)).lines()[0]!) as { level: string })
        .level,
    ).toBe('info');
  });

  it('does not autolog the liveness probe', () => {
    const req = fakeRequest({ url: '/health', originalUrl: '/health', method: 'GET' });
    const sink = runRequest(req, fakeResponse(200));
    expect(sink.lines()).toEqual([]);
  });

  it('adopts an incoming x-request-id rather than minting a second one', () => {
    const req = fakeRequest();
    (req.headers as Record<string, string>)['x-request-id'] = 'req_from_the_dashboard';
    runRequest(req, fakeResponse());
    expect(req.id).toBe('req_from_the_dashboard');
  });
});

describe('bindings and serialisers', () => {
  it('reads identity from req.ctx rather than deriving it again', () => {
    const req = {
      ctx: {
        requestId: 'req_1',
        branchId: 'branch-1',
        actorUserId: 'user-1',
        actorRole: 'MANAGER',
      },
      route: { path: '/reservations/:id' },
      baseUrl: '/v1',
      url: '/v1/reservations/0192f8c1',
    };
    expect(requestBindings(req as any)).toEqual({
      route: '/v1/reservations/:id',
      userId: 'user-1',
      role: 'MANAGER',
      branchId: 'branch-1',
    });
  });

  it('binds nothing before the interceptor has run, so route is never logged twice', () => {
    expect(requestBindings({ url: '/v1/reservations' } as any)).toEqual({});
  });

  it('falls back to the path when no route matched', () => {
    expect(routeOf({ url: '/v1/nope?phone=0501234567' } as any)).toBe('/v1/nope');
    expect(pathOf({ originalUrl: '/v1/guests?phone=0501234567' } as any)).toBe('/v1/guests');
  });

  it('keeps an error stack but strips the request body hanging off it', () => {
    const error = Object.assign(new Error('upstream refused'), {
      request: { method: 'POST', body: { guestPhone: SECRETS.guestPhone } },
    });

    const sink = capture();
    pino(buildPinoOptions(ENV), sink.stream).error({ err: error }, 'outbound call failed');

    expect(sink.raw()).toContain('upstream refused');
    expect(sink.raw()).toContain('logger.spec.ts'); // the stack survived
    assertNothingLeaked(sink.raw());

    const serialised = serialiseError(error) as Record<string, unknown>;
    expect(serialised.request).toEqual({ body: REDACTION_CENSOR });
    expect(typeof serialised.stack).toBe('string');
  });

  it('masks personal data that an error flattened into its message', () => {
    // Prisma renders the offending arguments into the message of a
    // PrismaClientValidationError, which is how a phone number ends up in prose.
    const message = `Invalid \`prisma.guest.create()\` invocation: { guestPhone: "${SECRETS.guestPhone}", fullName: "${SECRETS.guestName}" }`;
    const scrubbed = scrubPiiFromText(message);

    expect(scrubbed).not.toContain(SECRETS.guestPhone);
    expect(scrubbed).not.toContain(SECRETS.guestName);
    expect(scrubbed).toContain('prisma.guest.create()');

    const sink = capture();
    pino(buildPinoOptions(ENV), sink.stream).error(
      { err: new Error(message) },
      'unhandled database error',
    );
    assertNothingLeaked(sink.raw());
  });
});
