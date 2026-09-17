'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, ApiUnreachable } from './api-client';
import { useAuth } from './auth-context';

/**
 * One report, kept warm.
 *
 * This is `reservations-context.tsx`'s rule applied to the back office: if the
 * API cannot be reached, the page keeps rendering the LAST figures it actually
 * received, says loudly that they are old, and never invents a zero. Spec §12.2.
 *
 * A zero on a revenue report is not a harmless placeholder. "The spa took
 * nothing on Tuesday" is a sentence somebody acts on — they ring the
 * receptionist, they check the till, they doubt the system. An empty screen
 * that says why is a better answer than a confident wrong one.
 *
 * Asking a DIFFERENT question and failing is not the same as failing to refresh
 * the one on screen, so the two are reported separately: `stale` means the
 * numbers below are real but old, `unavailable` means there is nothing to show
 * for what was asked. Only the first keeps rendering.
 */

export interface ReportState<T> {
  data: T | null;
  /** True until the first answer of any kind arrives for this question. */
  loading: boolean;
  /** Real figures, last refresh failed. Render them, banner them, date them. */
  stale: boolean;
  /** Nothing to show for this question and the API will not answer. */
  unavailable: boolean;
  error: unknown;
  lastSuccessAt: number | null;
  /** The question these figures answer — not necessarily the one being asked. */
  loadedPath: string | null;
  refresh: () => void;
}

export function useReport<T>(path: string): ReportState<T> {
  const { client, status } = useAuth();
  const [data, setData] = useState<T | null>(null);
  const [loadedPath, setLoadedPath] = useState<string | null>(null);
  const [lastSuccessAt, setLastSuccessAt] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const inFlight = useRef<string | null>(null);

  const authenticated = status === 'active';

  useEffect(() => {
    if (!authenticated) return;

    let cancelled = false;
    inFlight.current = path;

    void (async () => {
      try {
        const next = await client.request<T>(path);
        if (cancelled) return;
        setData(next);
        setLoadedPath(path);
        setLastSuccessAt(Date.now());
        setError(null);
      } catch (failure) {
        if (cancelled) return;
        // A 401 is already being handled by the client's refresh-and-retry; if
        // it reaches here the session is gone and the shell shows the login.
        if (failure instanceof ApiError && failure.status === 401) return;
        setError(failure);
      } finally {
        if (!cancelled) inFlight.current = null;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [client, path, attempt, authenticated]);

  const refresh = useCallback(() => setAttempt((n) => n + 1), []);

  const showingThisQuestion = loadedPath === path;

  return {
    // Figures from a different range must never be shown under this one's
    // heading. They were true; they are not an answer to what is on screen.
    data: showingThisQuestion ? data : null,
    loading: !showingThisQuestion && error === null,
    stale: error !== null && showingThisQuestion,
    unavailable: error !== null && !showingThisQuestion,
    error,
    lastSuccessAt,
    loadedPath,
    refresh,
  };
}

/** "2 minutes ago" — the stale banner has to keep counting up while it is down. */
export function relativeTime(at: number | null, now: number = Date.now()): string {
  if (at === null) return 'never';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'} ago`;
}

/** What went wrong, in one line a manager can act on. */
export function failureMessage(error: unknown): string {
  if (error instanceof ApiUnreachable) return 'The booking system cannot be reached.';
  if (error instanceof ApiError) return error.message;
  return 'Something went wrong reading this report.';
}
