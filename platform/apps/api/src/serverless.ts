import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { Express } from 'express';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Logger as PinoNestLogger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { initSentry } from './common/sentry';
import { PrismaService } from './prisma/prisma.service';

/**
 * The serverless entry point. Loaded by api/index.ts, which is the file Vercel
 * actually invokes; see that file for why the shim exists.
 *
 * ── ONE NEST APPLICATION PER INSTANCE, NOT PER REQUEST ──────────────────────
 *
 * The cached PROMISE below is the whole trick. A serverless instance is reused
 * for many invocations, but two invocations can arrive before the first boot
 * has finished — caching only the FINISHED app would let both start one, and
 * the loser's Prisma client would leak a pooled connection that nothing ever
 * closes. Caching the promise means the second invocation awaits the first
 * one's boot. `NestFactory.create` per request would also mean a Prisma client
 * per request, which is precisely how a serverless API exhausts a connection
 * pooler.
 *
 * A rejected promise is NOT kept: a boot that failed because the database was
 * briefly unreachable must not condemn the instance to serve 500s for its whole
 * lifetime.
 */
let instance: Promise<Express> | undefined;

async function boot(): Promise<Express> {
  const startedAt = Date.now();

  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  const logger = app.get(PinoNestLogger);
  app.useLogger(logger);
  app.flushLogs();

  const config = app.get(ConfigService);

  initSentry({
    dsn: config.get<string>('SENTRY_DSN'),
    environment: String(config.get('NODE_ENV')),
    warn: (message) => logger.warn(message, 'bootstrap'),
  });

  // helmet, cookie-parser, the 128 KB json cap, CORS, the /v1 prefix and
  // `trust proxy` — the same call main.ts makes, for the same reasons.
  configureApp(app);

  await app.get(PrismaService).enableShutdownHooks(app);
  app.enableShutdownHooks();

  // If the platform ever does let the event loop empty between invocations,
  // PrismaService's `beforeExit` hook closes the application — and a closed
  // application must never be served from again. Dropping the cache here costs
  // one extra boot in a case that should not arise, and avoids the alternative:
  // an instance answering with a disconnected Prisma client.
  process.once('beforeExit', () => {
    instance = undefined;
  });

  // `init`, not `listen`. There is no port to bind: the platform hands the
  // request straight to the Express instance below.
  await app.init();

  // One line per cold start, in the same JSON as every other log. It is the
  // only honest source of what a cold start costs on the real deployment —
  // measure it there rather than believing anyone's estimate. §12.3.
  logger.log(
    `BE RELAX API booted in ${Date.now() - startedAt} ms (${config.get('NODE_ENV')})`,
    'bootstrap',
  );

  return app.getHttpAdapter().getInstance() as Express;
}

/**
 * Vercel's Node runtime calls this with the raw Node request and response, which
 * is exactly what an Express application is: a `(req, res)` function.
 */
export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  instance ??= boot().catch((error: unknown) => {
    instance = undefined;
    throw error;
  });

  (await instance)(req, res);
}
