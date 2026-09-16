'use client';

import { useEffect, useState } from 'react';
import { useReservations } from '@/lib/reservations-context';
import { Button } from './ui/button';

/**
 * Degrade, don't lie. Spec §12.2.
 *
 * When the API cannot be reached the grid keeps showing the last response it
 * actually received — and says so, loudly, with the time of that response. Every
 * write button in the app is disabled while this is up (`writesEnabled`), so a
 * receptionist can never believe they took a payment that was not recorded.
 *
 * There is deliberately no offline queue: a money write that might land later is
 * worse than one that plainly failed.
 */
export function StaleBanner(): JSX.Element | null {
  const { stale, lastSuccessAt, failureMessage, refresh } = useReservations();
  const [, setTick] = useState(0);

  // "2 minutes ago" has to keep counting up while the connection is down.
  useEffect(() => {
    if (!stale) return;
    const timer = setInterval(() => setTick((n) => n + 1), 15_000);
    return () => clearInterval(timer);
  }, [stale]);

  if (!stale) return null;

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b-2 border-alert bg-alert px-4 py-3 text-white sm:px-6"
    >
      <svg viewBox="0 0 24 24" className="h-5 w-5 flex-none" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M12 9v4M12 17h.01" strokeLinecap="round" />
        <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      </svg>

      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-semibold leading-tight">
          Showing old information — taking payments is switched off
        </p>
        <p className="text-[13.5px] leading-snug opacity-95">
          {failureMessage} Last updated {relative(lastSuccessAt)}. Nothing you do now would be
          recorded, so check-in and checkout are disabled until it is back.
        </p>
      </div>

      <Button
        variant="secondary"
        size="md"
        className="border-white bg-white/95 text-alert-deep hover:bg-white"
        onClick={() => void refresh()}
      >
        Try again
      </Button>
    </div>
  );
}

function relative(at: number | null): string {
  if (at === null) return 'never';
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'} ago`;
}
