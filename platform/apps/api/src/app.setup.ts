import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import { json } from 'express';
import helmet from 'helmet';

/**
 * Everything the application needs on top of its module graph.
 *
 * It lives here, in one function, because there are now two entry points —
 * `main.ts` for a long-lived process and `serverless.ts` for Vercel — and a
 * hardening step applied by only one of them is a hardening step the API does
 * not have. §12.4 is a list of things that must be true of every request,
 * whatever started the process serving it.
 *
 * Call it before `listen()` or `init()`: Express middleware registered after
 * the router has been built does not run.
 */
export function configureApp(app: INestApplication): void {
  const config = app.get(ConfigService);

  app.setGlobalPrefix('v1', { exclude: ['health', 'health/ready'] });

  app.use(helmet());
  app.use(cookieParser());
  // A booking payload is small. A 128 KB cap turns a malicious multi-megabyte
  // body into a cheap rejection instead of an expensive parse.
  app.use(json({ limit: '128kb' }));

  app.enableCors({
    origin: [
      config.get<string>('DASHBOARD_ORIGIN')!,
      config.get<string>('PUBLIC_SITE_ORIGIN')!,
    ].filter(Boolean),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Request-Id'],
  });

  // No global ValidationPipe: that one needs class-validator, and this stack
  // validates with zod through ZodValidationPipe at each route, so the DTO and
  // the runtime check come from a single schema in @berelax/contracts.

  // Behind Vercel's edge (or Cloudflare), so x-forwarded-for is the real client
  // and the socket address is a proxy. Without this every rate limit keyed on
  // an IP counts the whole internet as one caller.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
}
