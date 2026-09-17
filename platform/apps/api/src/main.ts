import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Logger as PinoNestLogger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { initSentry } from './common/sentry';
import { PrismaService } from './prisma/prisma.service';

/**
 * The long-lived process: `node dist/main.js`, used for local development and
 * by anything that runs the API as a server rather than as a function. The
 * production deployment goes through serverless.ts; both share configureApp()
 * so neither can quietly lose a hardening step the other has.
 */
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

  configureApp(app);

  await app.get(PrismaService).enableShutdownHooks(app);
  app.enableShutdownHooks();

  const port = config.get<number>('PORT') ?? 3000;
  await app.listen(port, '0.0.0.0');
  logger.log(`BE RELAX API listening on :${port} (${config.get('NODE_ENV')})`, 'bootstrap');
}

void bootstrap();
