import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import { validateEnv } from './config/env';
import { PrismaModule } from './prisma/prisma.module';
import { CommonModule } from './common/common.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { PrismaErrorFilter } from './common/prisma-error.filter';
import { RequestContextInterceptor } from './common/request-context.interceptor';
import { IdempotencyInterceptor } from './common/idempotency.interceptor';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './auth/roles.guard';
import { ReservationsModule } from './reservations/reservations.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv, cache: true }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: () => ({
        throttlers: [
          { name: 'default', ttl: 60_000, limit: 300 },   // authenticated: 300/min
          { name: 'burst', ttl: 1_000, limit: 20 },
        ],
      }),
    }),
    PrismaModule,
    CommonModule,
    AuthModule,
    ReservationsModule,
    HealthModule,
  ],
  providers: [
    // Order matters. Filters are applied last-registered-first, so the Prisma
    // filter must come after the catch-all to get first refusal on DB errors.
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_FILTER, useClass: PrismaErrorFilter },

    { provide: APP_INTERCEPTOR, useClass: RequestContextInterceptor },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },

    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
