import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ErrorCode } from '@berelax/contracts';

/**
 * Last line of defence. Every response leaving this API has the same shape,
 * so the dashboard never has to guess: { error: { code, message, details?, requestId } }.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<Request>();
    const requestId = req.ctx?.requestId;

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();

      // A handler that already threw our shape passes straight through.
      if (typeof body === 'object' && body !== null && 'error' in body) {
        const err = (body as { error: Record<string, unknown> }).error;
        res.status(status).json({ error: { ...err, requestId } });
        return;
      }

      // Nest's ThrottlerException stringifies to "ThrottlerException: Too Many
      // Requests" — an exception class name is not something to show a
      // receptionist, or to leak to whoever is hammering the login endpoint.
      if (status === HttpStatus.TOO_MANY_REQUESTS) {
        res.status(status).json({
          error: {
            code: ErrorCode.RATE_LIMITED,
            message: 'Too many attempts. Wait a moment and try again.',
            requestId,
          },
        });
        return;
      }

      const message =
        typeof body === 'string'
          ? body
          : ((body as { message?: string | string[] })?.message ?? exception.message);

      res.status(status).json({
        error: {
          code: statusToCode(status),
          message: Array.isArray(message) ? message.join('; ') : message,
          requestId,
        },
      });
      return;
    }

    this.logger.error(
      { err: exception instanceof Error ? exception.stack : String(exception), requestId, path: req.url },
      'unhandled exception',
    );

    // Never leak an internal message to a caller.
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: { code: ErrorCode.INTERNAL_ERROR, message: 'Something went wrong.', requestId },
    });
  }
}

function statusToCode(status: number): string {
  switch (status) {
    case HttpStatus.TOO_MANY_REQUESTS: return ErrorCode.RATE_LIMITED;
    case HttpStatus.UNAUTHORIZED: return ErrorCode.INVALID_CREDENTIALS;
    case HttpStatus.FORBIDDEN: return ErrorCode.INSUFFICIENT_ROLE;
    case HttpStatus.NOT_FOUND: return ErrorCode.NOT_FOUND;
    case HttpStatus.UNPROCESSABLE_ENTITY: return ErrorCode.VALIDATION_FAILED;
    default: return ErrorCode.INTERNAL_ERROR;
  }
}
