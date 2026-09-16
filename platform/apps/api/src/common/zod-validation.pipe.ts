import {
  ArgumentMetadata,
  Injectable,
  PipeTransform,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { ZodIssue, ZodTypeAny, z } from 'zod';
import { ErrorCode } from '@berelax/contracts';

/**
 * The contracts package owns the shapes; this pipe is the only place they are
 * enforced at the edge. 422 rather than 400 because the request parsed fine —
 * it is the content that is wrong. Spec §3.6.
 */
@Injectable()
export class ZodValidationPipe<T extends ZodTypeAny> implements PipeTransform<unknown, z.infer<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown, _metadata: ArgumentMetadata): z.infer<T> {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;

    throw new UnprocessableEntityException({
      error: {
        code: ErrorCode.VALIDATION_FAILED,
        message: firstMessage(result.error.issues),
        // Paths and messages only. The submitted value is never echoed, because
        // the body that failed validation may well be a login attempt.
        details: {
          issues: result.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
      },
    });
  }
}

/** The dashboard shows `message` verbatim, so it is the first real problem, not a count. */
function firstMessage(issues: ZodIssue[]): string {
  const first = issues[0];
  if (!first) return 'The request did not pass validation.';
  const path = first.path.join('.');
  return path ? `${path}: ${first.message}` : first.message;
}
