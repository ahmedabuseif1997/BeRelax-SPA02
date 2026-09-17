import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';

import { validateEnv } from './config/env';
import type { Env } from './config/env';
import { buildLoggerParams } from './common/logger';
import { PrismaModule } from './prisma/prisma.module';
import { CommonModule } from './common/common.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { PrismaErrorFilter } from './common/prisma-error.filter';
import { RequestContextInterceptor } from './common/request-context.interceptor';
import { PgThrottlerStorage } from './common/pg-throttler.storage';
import { UserThrottlerGuard } from './common/user-throttler.guard';
import { IdempotencyInterceptor } from './common/idempotency.interceptor';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './auth/roles.guard';
import { ReservationsModule } from './reservations/reservations.module';
import { AvailabilityModule } from './availability/availability.module';
import { BookingRequestsModule } from './booking-requests/booking-requests.module';
import { PublicModule } from './public/public.module';
import { GuestsModule } from './guests/guests.module';
import { EmployeesModule } from './employees/employees.module';
import { CatalogueModule } from './catalogue/catalogue.module';
import { ShiftsModule } from './shifts/shifts.module';
import { PaymentsModule } from './payments/payments.module';
import { ComplianceModule } from './compliance/compliance.module';
import { ReportsModule } from './reports/reports.module';
import { ReconciliationModule } from './reconciliation/reconciliation.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv, cache: true }),

    // Imported before anything else that registers middleware: Nest applies
    // middleware in module-import order, and a request logged from the second
    // middleware onwards is a request whose first line is missing. Spec §12.3.
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        buildLoggerParams({
          LOG_LEVEL: config.get('LOG_LEVEL', { infer: true }),
          NODE_ENV: config.get('NODE_ENV', { infer: true }),
        }),
    }),

    ThrottlerModule.forRootAsync({
      imports: [CommonModule],
      inject: [PgThrottlerStorage],
      useFactory: (storage: PgThrottlerStorage) => ({
        // Spec §12.4. Keyed per user by UserThrottlerGuard, falling back to IP
        // for public routes. The tighter per-IP limits on /auth/login and the
        // public endpoints are declared at those routes with @Throttle.
        throttlers: [{ name: 'default', ttl: 60_000, limit: 300 }],

        // NOT the default in-memory storage. One counter per process means the
        // limit is multiplied by the instance count, which on a serverless
        // platform is a number nobody controls. See pg-throttler.storage.ts.
        storage,
      }),
    }),
    PrismaModule,
    CommonModule,
    AuthModule,
    ReservationsModule,
    AvailabilityModule,
    BookingRequestsModule,
    PublicModule,
    GuestsModule,
    EmployeesModule,
    CatalogueModule,
    ShiftsModule,
    PaymentsModule,
    ComplianceModule,
    ReportsModule,
    ReconciliationModule,
    HealthModule,
  ],
  providers: [
    // Order matters. Filters are applied last-registered-first, so the Prisma
    // filter must come after the catch-all to get first refusal on DB errors.
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_FILTER, useClass: PrismaErrorFilter },

    { provide: APP_INTERCEPTOR, useClass: RequestContextInterceptor },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },

    // JwtAuthGuard runs FIRST so the throttler can key on req.user.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: UserThrottlerGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
