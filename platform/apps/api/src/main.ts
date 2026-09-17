import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { json } from 'express';
import { Logger as PinoNestLogger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { initSentry } from './common/sentry';
import { PrismaService } from './prisma/prisma.service';

async function bootstrap(): Promise<void> {
  // Buffered: nothing is written until useLogger() below hands Nest the pino
  // logger, so the boot banner comes out in the same JSON as every other line
  // rather than in Nest's coloured format that no log platform can parse.
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  // Replaces Nest's default logger everywhere, including the `new Logger(...)`
  // instances scattered through the services — those delegate to whatever is
  // registered here. Spec §12.3.
  const logger = app.get(PinoNestLogger);
  app.useLogger(logger);
  app.flushLogs();

  const config = app.get(ConfigService);

  // A no-op until @sentry/node is installed; see src/common/sentry.ts for what
  // it does when it is, and why it must then move above NestFactory.create.
  initSentry({
    dsn: config.get<string>('SENTRY_DSN'),
    environment: String(config.get('NODE_ENV')),
    warn: (message) => logger.warn(message, 'bootstrap'),
  });

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

  // Behind Railway/Render/Cloudflare, so x-forwarded-for is the real client.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  await app.get(PrismaService).enableShutdownHooks(app);
  app.enableShutdownHooks();

  const port = config.get<number>('PORT') ?? 3000;
  await app.listen(port, '0.0.0.0');
  logger.log(`BE RELAX API listening on :${port} (${config.get('NODE_ENV')})`, 'bootstrap');
}

void bootstrap();
