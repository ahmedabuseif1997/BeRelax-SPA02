import {
  BadRequestException, CallHandler, ConflictException, ExecutionContext,
  Injectable, NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { createHash } from 'node:crypto';
import { Observable, from, of, switchMap, tap } from 'rxjs';
import { ErrorCode } from '@berelax/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { IDEMPOTENT_KEY } from './decorators';

/**
 * Reception runs on an iPad over patchy Wi-Fi at 01:00. A request times out, the
 * receptionist taps Confirm again — and without this the guest is charged twice.
 * Spec §7.6.
 *
 *   1. No key on a money endpoint         -> 400 IDEMPOTENCY_KEY_REQUIRED
 *   2. Key seen, same body, complete      -> replay the stored response
 *   3. Key seen, DIFFERENT body           -> 409 IDEMPOTENCY_KEY_REUSED
 *   4. Key seen, still in flight          -> 409 REQUEST_IN_PROGRESS
 *   5. New key                            -> execute, store, return
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const required = this.reflector.getAllAndOverride<boolean>(IDEMPOTENT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return next.handle();

    const req = context.switchToHttp().getRequest<Request>();
    const key = req.header('idempotency-key');

    if (!key) {
      throw new BadRequestException({
        error: {
          code: ErrorCode.IDEMPOTENCY_KEY_REQUIRED,
          message: 'This action moves money and needs an Idempotency-Key header.',
        },
      });
    }

    const endpoint = `${req.method} ${req.route?.path ?? req.path}`;
    const requestHash = createHash('sha256')
      .update(JSON.stringify(req.body ?? {}))
      .digest('hex');
    const userId = req.user?.id ?? '00000000-0000-0000-0000-000000000000';

    return from(this.prisma.idempotencyRecord.findUnique({ where: { key } })).pipe(
      switchMap((existing) => {
        if (existing) {
          if (existing.requestHash !== requestHash) {
            throw new ConflictException({
              error: {
                code: ErrorCode.IDEMPOTENCY_KEY_REUSED,
                message: 'That idempotency key was already used for a different request.',
              },
            });
          }
          // statusCode 0 is the in-flight marker written before the handler runs.
          if (existing.statusCode === 0) {
            throw new ConflictException({
              error: {
                code: ErrorCode.REQUEST_IN_PROGRESS,
                message: 'That request is still being processed. Wait a moment before retrying.',
              },
            });
          }
          return of(existing.responseBody);
        }

        const ttlHours = this.config.get<number>('IDEMPOTENCY_TTL_HOURS') ?? 24;
        const expiresAt = new Date(Date.now() + ttlHours * 3_600_000);

        // Claim the key first. A unique-violation here means a concurrent
        // duplicate won the race, which is exactly the case this guards.
        return from(
          this.prisma.idempotencyRecord.create({
            data: { key, userId, endpoint, requestHash, statusCode: 0, responseBody: {}, expiresAt },
          }),
        ).pipe(
          switchMap(() => next.handle()),
          tap({
            next: (body) => {
              void this.prisma.idempotencyRecord
                .update({
                  where: { key },
                  data: {
                    statusCode: context.switchToHttp().getResponse<{ statusCode: number }>().statusCode,
                    responseBody: (body ?? {}) as object,
                  },
                })
                .catch(() => undefined);
            },
            error: () => {
              // Release the key so a corrected retry is not permanently blocked
              // by a failed attempt.
              void this.prisma.idempotencyRecord.delete({ where: { key } }).catch(() => undefined);
            },
          }),
        );
      }),
    );
  }
}
