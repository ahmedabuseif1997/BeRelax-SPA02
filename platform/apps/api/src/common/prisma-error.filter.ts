import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { Prisma } from '@prisma/client';
import { ErrorCode } from '@berelax/contracts';

/** PostgreSQL SQLSTATEs this system deliberately turns into readable HTTP errors. */
const PG = {
  EXCLUSION_VIOLATION: '23P01',
  UNIQUE_VIOLATION: '23505',
  CHECK_VIOLATION: '23514',
  FOREIGN_KEY_VIOLATION: '23503',
  INSUFFICIENT_PRIVILEGE: '42501',
} as const;

/**
 * The database rejects the conflict. This filter's only job is turning that
 * rejection into something a receptionist understands at 01:00 on a Friday.
 * Spec §5.5.
 */
const CONSTRAINT_MESSAGES: Record<string, { code: string; message: string }> = {
  reservations_no_therapist_overlap: {
    code: ErrorCode.THERAPIST_ALREADY_BOOKED,
    message: 'That therapist already has a booking overlapping this time.',
  },
  reservations_no_room_overlap: {
    code: ErrorCode.ROOM_ALREADY_BOOKED,
    message: 'That room is already in use during this time.',
  },
  reservations_no_guest_overlap: {
    code: ErrorCode.GUEST_ALREADY_BOOKED,
    message: 'This guest already has a treatment booked at this time.',
  },
  users_email_unique_active: {
    code: ErrorCode.VALIDATION_FAILED,
    message: 'An active user already exists with that email address.',
  },
  tips_direct_cash_has_no_payment: {
    code: ErrorCode.TIP_METHOD_NOT_ALLOWED,
    message: 'Cash handed straight to the therapist cannot carry a payment method.',
  },
  guests_notes_are_preferences_not_history: {
    code: ErrorCode.VALIDATION_FAILED,
    message: 'Guest notes are for preferences only and must stay under 500 characters.',
  },
};

@Catch(
  Prisma.PrismaClientKnownRequestError,
  Prisma.PrismaClientUnknownRequestError,
  Prisma.PrismaClientValidationError,
)
export class PrismaErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(PrismaErrorFilter.name);

  catch(err: Error, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const requestId = http.getRequest<{ ctx?: { requestId?: string } }>().ctx?.requestId;

    // Prisma surfaces raw-SQL failures as P2010 and wraps others; the driver
    // SQLSTATE and the constraint name both end up in the message text, so
    // match on the combined haystack rather than a field that may not exist.
    const meta = (err as Prisma.PrismaClientKnownRequestError).meta ?? {};
    const haystack = `${JSON.stringify(meta)} ${err.message ?? ''}`;

    const known = (code: string) => haystack.includes(code);
    const namedConstraint = Object.keys(CONSTRAINT_MESSAGES).find((n) => haystack.includes(n));

    if (known(PG.EXCLUSION_VIOLATION) || (namedConstraint && known(PG.CHECK_VIOLATION))) {
      const mapped = namedConstraint
        ? CONSTRAINT_MESSAGES[namedConstraint]!
        : { code: ErrorCode.SLOT_CONFLICT, message: 'That slot is no longer available.' };
      res.status(HttpStatus.CONFLICT).json({ error: { ...mapped, requestId } });
      return;
    }

    if (known(PG.UNIQUE_VIOLATION) || (err as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
      const mapped = namedConstraint
        ? CONSTRAINT_MESSAGES[namedConstraint]!
        : { code: ErrorCode.VALIDATION_FAILED, message: 'That value is already in use.' };
      res.status(HttpStatus.CONFLICT).json({ error: { ...mapped, requestId } });
      return;
    }

    // The status-machine trigger and the append-only guards.
    if (known(PG.CHECK_VIOLATION) && haystack.includes('illegal reservation status transition')) {
      res.status(HttpStatus.CONFLICT).json({
        error: {
          code: ErrorCode.ILLEGAL_STATUS_TRANSITION,
          message: 'That booking cannot move to this state.',
          requestId,
        },
      });
      return;
    }

    if (known(PG.INSUFFICIENT_PRIVILEGE) && haystack.includes('append-only')) {
      // A bug, not a user error: something tried to edit an immutable financial
      // row. Loud in the logs, generic to the caller.
      this.logger.error({ err: err.message, requestId }, 'attempted mutation of an append-only table');
      res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
        error: {
          code: ErrorCode.INTERNAL_ERROR,
          message: 'That record cannot be changed. Raise a correcting entry instead.',
          requestId,
        },
      });
      return;
    }

    if ((err as Prisma.PrismaClientKnownRequestError).code === 'P2025') {
      res.status(HttpStatus.NOT_FOUND).json({
        error: { code: ErrorCode.NOT_FOUND, message: 'Not found.', requestId },
      });
      return;
    }

    if (known(PG.FOREIGN_KEY_VIOLATION) || (err as Prisma.PrismaClientKnownRequestError).code === 'P2003') {
      res.status(HttpStatus.UNPROCESSABLE_ENTITY).json({
        error: {
          code: ErrorCode.VALIDATION_FAILED,
          message: 'One of the referenced records does not exist.',
          requestId,
        },
      });
      return;
    }

    this.logger.error({ err: err.message, requestId }, 'unhandled database error');
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: { code: ErrorCode.INTERNAL_ERROR, message: 'Something went wrong.', requestId },
    });
  }
}
