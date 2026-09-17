import { stdSerializers } from 'pino';
import type { Level, LoggerOptions } from 'pino';
import type { Params } from 'nestjs-pino';
import type { Options as PinoHttpOptions } from 'pino-http';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { REDACTION_CENSOR, REDACT_PATHS, scrubPiiFromText } from './pii';
import { clientIp, resolveRequestId } from './request-context';
import type { RequestContext } from './request-context';

/**
 * Structured logging. Spec §12.3.
 *
 * Every line carries `requestId`, and once the request has been through
 * RequestContextInterceptor, `route`, `userId`, `role` and `branchId`. The
 * values are read from `req.ctx` and `req.user`, which the guard and the
 * interceptor have already assembled — this file derives none of them a second
 * time, because two derivations of "who is this" is one derivation too many.
 *
 * ── FORMAT ────────────────────────────────────────────────────────────────
 * JSON everywhere, development included. §12.3 asks for pretty output locally,
 * but `pino-pretty` is NOT installed and is not a dependency of this app, and
 * adding an unused dependency is exactly what left `pino` itself sitting in
 * package.json imported by nothing. To turn pretty printing on:
 *
 *     pnpm --filter api add -D pino-pretty
 *
 * and give `buildPinoOptions` a `transport` in development:
 *
 *     ...(env.NODE_ENV === 'development' && {
 *       transport: { target: 'pino-pretty', options: { singleLine: true, translateTime: 'HH:MM:ss' } },
 *     }),
 *
 * Nothing else changes: the redaction below runs before the transport sees a
 * line, so a pretty log is exactly as redacted as a JSON one.
 */

/** Only the parts of an Express request this file touches. */
interface HttpRequest extends IncomingMessage {
  originalUrl?: string;
  baseUrl?: string;
  route?: { path?: string };
  ctx?: RequestContext;
}

/**
 * Liveness probes and asset requests. A container platform hits `/health` every
 * few seconds forever; logged, it buries the twenty lines a night that matter.
 * These are excluded from AUTOLOGGING only — an error raised while serving one
 * still logs, because a readiness probe that fails is the alert.
 */
const UNLOGGED_PATHS =
  /^\/(health(\/.*)?|favicon\.ico|robots\.txt|sitemap\.xml|metrics|static\/.*|assets\/.*)$/;

/** Path without the query string. `?phone=05…` is guest input and never logged. */
export function pathOf(req: HttpRequest): string {
  const raw = req.originalUrl ?? req.url ?? '';
  const query = raw.indexOf('?');
  return query === -1 ? raw : raw.slice(0, query);
}

/**
 * The matched route pattern — `/v1/reservations/:id`, not
 * `/v1/reservations/0192f…`. §12.3 wants `route` on the line, and a pattern is
 * what you can group an error rate by; a path with an id in it is cardinality.
 * Express fills `req.route` once a handler matches, so before routing (and for
 * a 404) this falls back to the path.
 */
export function routeOf(req: HttpRequest): string {
  const pattern = req.route?.path;
  if (typeof pattern === 'string' && pattern.length > 0) return `${req.baseUrl ?? ''}${pattern}`;
  return pathOf(req);
}

/**
 * The per-request bindings, taken from what the guard and the interceptor have
 * already put on the request.
 *
 * Empty until RequestContextInterceptor has run. That is deliberate: pino-http
 * evaluates `customProps` once as middleware and again when the response
 * finishes, and returning a half-built set the first time would put `route` on
 * the line twice with two different values.
 */
export function requestBindings(req: HttpRequest): Record<string, string> {
  const ctx = req.ctx;
  if (!ctx) return {};

  const bindings: Record<string, string> = { route: routeOf(req) };
  if (ctx.actorUserId) bindings.userId = ctx.actorUserId;
  if (ctx.actorRole) bindings.role = ctx.actorRole;
  if (ctx.branchId) bindings.branchId = ctx.branchId;
  return bindings;
}

/**
 * Method, path and caller IP. No headers, no body, no query string — the three
 * places guest data actually arrives. §11.6 retains logs carrying IPs for 90
 * days and the privacy notice says so, which is why the IP stays.
 */
function serialiseRequest(req: IncomingMessage): Record<string, unknown> {
  const request = req as HttpRequest;
  return {
    method: request.method,
    path: pathOf(request),
    ip: clientIp(request),
  };
}

/** Status only. A response header set is `set-cookie`, and that is a session. */
function serialiseResponse(res: ServerResponse): Record<string, unknown> {
  return { statusCode: res.statusCode };
}

/**
 * Keeps the stack — an error without one is a mystery — and drops the request
 * body that HTTP clients staple onto their errors. A failed outbound call must
 * not smuggle the payload that failed into a log line.
 */
export function serialiseError(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return typeof error === 'string' ? scrubPiiFromText(error) : error;
  }

  const serialised = stdSerializers.err(error) as Record<string, unknown>;
  if (typeof serialised.message === 'string') {
    serialised.message = scrubPiiFromText(serialised.message);
  }
  // The stack's first line IS the message, so scrubbing one without the other
  // redacts nothing at all.
  if (typeof serialised.stack === 'string') {
    serialised.stack = scrubPiiFromText(serialised.stack);
  }

  const request = serialised.request;
  if (request !== null && typeof request === 'object') {
    // Replaced rather than deleted: "there was a request and we are not showing
    // you it" is a more useful thing to read at 02:00 than silence.
    serialised.request = { body: REDACTION_CENSOR };
  }
  return serialised;
}

/**
 * Everything the app-level logger and the HTTP logger share.
 *
 * `NODE_ENV` is carried but unused: it is the switch for the `transport` block
 * described at the top of this file, and threading it through now means adding
 * pino-pretty later is one edit rather than three.
 */
export function buildPinoOptions(env: { LOG_LEVEL: Level; NODE_ENV: string }): LoggerOptions {
  return {
    level: env.LOG_LEVEL,
    // ISO timestamps. `1789625224793` is not something anyone correlates with a
    // guest complaint about "around half eleven".
    timestamp: stdTime,
    // A label, not a number: the alert filters in docs/runbooks/alerts.md read
    // `level == "error"`, and so does whoever is grepping at 02:00.
    formatters: { level: (label) => ({ level: label }) },
    redact: { paths: [...REDACT_PATHS], censor: REDACTION_CENSOR },
    serializers: {
      req: serialiseRequest,
      res: serialiseResponse,
      err: serialiseError,
    },
  };
}

/** ISO 8601, in the shape pino expects (a `,"time":…` fragment). */
function stdTime(): string {
  return `,"time":"${new Date().toISOString()}"`;
}

/** The pino-http half: autologging, levels and the per-request bindings. */
export function buildPinoHttpOptions(env: { LOG_LEVEL: Level; NODE_ENV: string }): PinoHttpOptions {
  return {
    ...buildPinoOptions(env),

    // One id for the request, the response header, the error body and the audit
    // row. pino-http asks first, so this is where it is settled.
    genReqId: (req) => resolveRequestId(req as HttpRequest & { headers: NodeJS.Dict<string> }),
    // Puts `requestId` on every line from the first one, including lines from a
    // request rejected by a guard before any interceptor ran.
    quietReqLogger: true,
    customAttributeKeys: { reqId: 'requestId' },

    customProps: (req) => requestBindings(req as HttpRequest),

    // pino-http logs EVERYTHING at `info` unless told otherwise — a 500 would
    // be indistinguishable from a 200, and "API 5xx rate > 1%" (§12.3) is an
    // alert you cannot write against that.
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },

    autoLogging: { ignore: (req) => UNLOGGED_PATHS.test(pathOf(req as HttpRequest)) },
  };
}

/** What `LoggerModule.forRootAsync` is handed in app.module.ts. */
export function buildLoggerParams(env: { LOG_LEVEL: Level; NODE_ENV: string }): Params {
  return { pinoHttp: buildPinoHttpOptions(env) };
}
