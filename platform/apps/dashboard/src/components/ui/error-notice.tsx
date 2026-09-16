'use client';

import { ErrorCode } from '@berelax/contracts';
import { ApiError, ApiUnreachable } from '@/lib/api-client';
import { Button } from './button';

/**
 * The server's `message` was written to be read by this person, so it is shown
 * verbatim (spec §3.6). This component only adds the one line of context the
 * message cannot carry: whether it is safe to tap again.
 */
export function ErrorNotice({
  error,
  onRetry,
  retryLabel = 'Try again',
}: {
  error: unknown;
  onRetry?: () => void;
  retryLabel?: string;
}): JSX.Element | null {
  if (!error) return null;

  const { headline, message, hint, safeToRetry } = describe(error);

  return (
    <div
      role="alert"
      className="rounded-xl border border-alert-line bg-alert-pale px-4 py-3.5 text-[15px] text-alert-deep"
    >
      <p className="font-medium">{headline}</p>
      <p className="mt-1 leading-snug">{message}</p>
      {hint ? <p className="mt-2 text-[13.5px] opacity-90">{hint}</p> : null}
      {onRetry && safeToRetry ? (
        <Button variant="secondary" size="md" className="mt-3" onClick={onRetry}>
          {retryLabel}
        </Button>
      ) : null}
    </div>
  );
}

interface Described {
  headline: string;
  message: string;
  hint?: string;
  safeToRetry: boolean;
}

function describe(error: unknown): Described {
  if (error instanceof ApiUnreachable) {
    return {
      headline: 'Not saved — the system could not be reached',
      message: error.message,
      // The one thing a receptionist must know: nothing was taken.
      hint: 'Nothing was recorded. Check the Wi-Fi, then try again.',
      safeToRetry: true,
    };
  }

  if (error instanceof ApiError) {
    switch (error.code) {
      case ErrorCode.REQUEST_IN_PROGRESS:
        return {
          headline: 'Still going through',
          message: error.message,
          hint: 'Wait a few seconds and tap again — this cannot charge twice.',
          safeToRetry: true,
        };
      case ErrorCode.IDEMPOTENCY_KEY_REUSED:
        return {
          headline: 'That was already sent',
          message: error.message,
          hint: 'Close this and re-open the booking to see what was recorded.',
          safeToRetry: false,
        };
      case ErrorCode.BASE_PAYMENT_MISMATCH:
      case ErrorCode.INVALID_AMOUNT:
        return { headline: 'The amount does not add up', message: error.message, safeToRetry: false };
      case ErrorCode.TIP_EXCEEDS_SANITY_LIMIT:
        return { headline: 'That tip needs a manager', message: error.message, safeToRetry: false };
      case ErrorCode.INSUFFICIENT_ROLE:
        return { headline: 'Not your call', message: error.message, safeToRetry: false };
      case ErrorCode.RATE_LIMITED:
        return { headline: 'Too many attempts', message: error.message, safeToRetry: true };
      default:
        return {
          headline: error.status >= 500 ? 'Not saved' : 'That did not work',
          message: error.message,
          ...(error.requestId ? { hint: `Reference ${error.requestId}` } : {}),
          safeToRetry: error.status >= 500,
        };
    }
  }

  return {
    headline: 'Something went wrong',
    message: error instanceof Error ? error.message : 'Unexpected error.',
    safeToRetry: true,
  };
}
