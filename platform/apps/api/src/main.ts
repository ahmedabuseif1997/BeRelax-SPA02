import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { json } from 'express';

import { AppModule } from './app.module';
import { PrismaService } from './prisma/prisma.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  const config = app.get(ConfigService);
  const logger = new Logger('bootstrap');

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
  logger.log(`BE RELAX API listening on :${port} (${config.get('NODE_ENV')})`);
}

void bootstrap();
