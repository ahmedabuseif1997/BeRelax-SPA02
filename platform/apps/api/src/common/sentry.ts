import { REDACTION_CENSOR, PII_FIELDS, CREDENTIAL_FIELDS, scrubPiiFromText } from './pii';

/**
 * Sentry. Spec §12.3 — "Sentry for the API and the dashboard, with `beforeSend`
 * stripping PII from breadcrumbs".
 *
 * ── THIS IS AN ADAPTER, NOT AN INTEGRATION ────────────────────────────────
 * `@sentry/node` is NOT installed and is NOT a dependency of this app, so
 * `initSentry` reports nothing. It is written this way on purpose: this task
 * exists because `pino`, `pino-http` and `nestjs-pino` sat in package.json for
 * months imported by nothing, and adding `@sentry/node` unused would be the
 * same mistake with a different name.
 *
 * `scrubEvent` below is NOT a stub. It is the `beforeSend` §12.3 requires, it
 * is tested in `sentry.spec.ts`, and it is the only part of this file that has
 * to be right. To turn reporting on:
 *
 *   1.  pnpm --filter api add @sentry/node
 *   2.  in this file, replace the body of `initSentry` with:
 *
 *         import * as Sentry from '@sentry/node';
 *         Sentry.init({
 *           dsn: options.dsn,
 *           environment: options.environment,
 *           tracesSampleRate: 0,
 *           sendDefaultPii: false,       // belt; scrubEvent is the braces
 *           beforeSend: scrubEvent,
 *           beforeBreadcrumb: scrubBreadcrumb,
 *         });
 *
 *   3.  call it in `main.ts` BEFORE `NestFactory.create` — the SDK patches http
 *       and the Postgres driver when it initialises, and anything constructed
 *       before that is never instrumented. It is called after `create` today
 *       only because that is where a validated `SENTRY_DSN` first exists;
 *       with the real SDK, read `process.env.SENTRY_DSN` at the top of the file
 *       instead and let `validateEnv` keep owning the "is it valid" question.
 *
 * Nothing else in the codebase needs to change: unhandled exceptions already
 * funnel through AllExceptionsFilter, which logs them with the request context.
 */

/**
 * The parts of a Sentry event this file touches, declared locally so that no
 * type here depends on a package that is not installed. It is a structural
 * subset of `@sentry/types`' `Event` and `Breadcrumb`; passing `scrubEvent` to
 * the real `Sentry.init` type-checks against it.
 */
export interface SentryBreadcrumb {
  message?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SentryEvent {
  message?: string;
  request?: {
    url?: string;
    headers?: Record<string, string>;
    cookies?: Record<string, string> | string;
    data?: unknown;
    query_string?: unknown;
    [key: string]: unknown;
  };
  user?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  contexts?: Record<string, Record<string, unknown> | undefined>;
  breadcrumbs?: SentryBreadcrumb[];
  [key: string]: unknown;
}

const SENSITIVE = new Set<string>(
  [...PII_FIELDS, ...CREDENTIAL_FIELDS].map((f) => f.toLowerCase()),
);

/**
 * `beforeSend`. An error report is worth having; a copy of the guest database
 * inside a third party's error tracker is a cross-border transfer nobody
 * recorded (§11.7) and a retention schedule nobody wrote (§11.6).
 *
 * What survives: the exception, the stack, the route, the `requestId`, the
 * acting user's ID and role. What does not: request bodies, query strings,
 * cookies, headers, and every value under a name PII_FIELDS knows about.
 */
export function scrubEvent(event: SentryEvent): SentryEvent {
  if (event.request) {
    const { url, method } = event.request as { url?: string; method?: unknown };
    event.request = {
      // A query string is guest input. The path is enough to find the route.
      ...(url ? { url: url.split('?')[0] } : {}),
      ...(method ? { method } : {}),
    };
  }

  // The user's IDENTITY is the point of a bug report; their contact details are
  // not. Sentry's default integrations put both here.
  if (event.user) event.user = scrubValue(event.user) as Record<string, unknown>;

  if (event.extra) event.extra = scrubValue(event.extra) as Record<string, unknown>;

  if (event.contexts) {
    for (const [name, context] of Object.entries(event.contexts)) {
      if (context) event.contexts[name] = scrubValue(context) as Record<string, unknown>;
    }
  }

  if (event.message) event.message = scrubPiiFromText(event.message);

  if (event.breadcrumbs) event.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb);

  return event;
}

/**
 * `beforeBreadcrumb`. Breadcrumbs are the leak §12.3 names explicitly: the HTTP
 * and console integrations record every outbound URL and every logged argument,
 * which is where a guest's phone number arrives without anyone deciding it
 * should.
 */
export function scrubBreadcrumb(breadcrumb: SentryBreadcrumb): SentryBreadcrumb {
  const scrubbed: SentryBreadcrumb = { ...breadcrumb };
  if (typeof scrubbed.message === 'string') scrubbed.message = scrubPiiFromText(scrubbed.message);
  if (scrubbed.data) scrubbed.data = scrubValue(scrubbed.data) as Record<string, unknown>;
  return scrubbed;
}

/** Walks an arbitrary value, censoring anything under a sensitive key. */
function scrubValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return REDACTION_CENSOR;
  if (typeof value === 'string') return scrubPiiFromText(value);
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1));
  if (value === null || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE.has(key.toLowerCase()) ? REDACTION_CENSOR : scrubValue(child, depth + 1);
  }
  return out;
}

export interface SentryOptions {
  dsn?: string | undefined;
  environment: string;
  /** Anything that can carry the "you configured a DSN and nothing happened" warning. */
  warn: (message: string) => void;
}

/**
 * No-op until `@sentry/node` is installed. It is deliberately NOT silent: a DSN
 * in the environment means somebody expects to be paged, and finding out during
 * an incident that nothing was ever reporting is the failure this warning
 * exists to prevent.
 */
export function initSentry(options: SentryOptions): boolean {
  if (!options.dsn) return false;
  options.warn(
    'SENTRY_DSN is set but @sentry/node is not installed — no errors are being reported. ' +
      'See src/common/sentry.ts for the three steps that turn this on.',
  );
  return false;
}
