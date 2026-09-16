'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ApiError, ApiUnreachable } from './api-client';
import type { ReservationView } from './api-types';
import { useAuth } from './auth-context';
import { currentBusinessDay } from './grid-time';

/**
 * One trading day of reservations, kept warm.
 *
 * Two rules from spec §12.2 live here, and they are the reason this is a
 * provider rather than a hook called in three places:
 *
 *  - If the API is unreachable, the grid keeps rendering the LAST response with
 *    a prominent stale banner. Nothing disappears, nothing is invented.
 *  - While it is stale, `writesEnabled` is false and every write button in the
 *    app is disabled. A receptionist must never be able to believe they took a
 *    payment that was not recorded. There is no offline write queue — a money
 *    write that might land later is worse than one that plainly failed.
 *
 * The cache is in memory only, deliberately: a night's grid is guest names and
 * phone numbers, and that does not belong in localStorage on a shared iPad
 * (spec §11).
 */

const POLL_INTERVAL_MS = 30_000;

export interface ReservationsContextValue {
  day: string;
  isToday: boolean;
  setDay: (day: string) => void;
  reservations: ReservationView[];
  /** True until the first response of any kind has arrived. */
  loading: boolean;
  /** We have data, but the most recent attempt to refresh it failed. */
  stale: boolean;
  /** No data at all and the API will not answer. */
  unavailable: boolean;
  lastSuccessAt: number | null;
  failureMessage: string | null;
  writesEnabled: boolean;
  refresh: () => Promise<void>;
  /** Fold a write's response straight back into the grid, then re-fetch. */
  applyReservation: (reservation: ReservationView) => void;
}

const ReservationsContext = createContext<ReservationsContextValue | null>(null);

export function ReservationsProvider({ children }: { children: ReactNode }): JSX.Element {
  const { client, status: sessionStatus } = useAuth();
  const [day, setDay] = useState(() => currentBusinessDay());
  const [reservations, setReservations] = useState<ReservationView[]>([]);
  const [loadedDay, setLoadedDay] = useState<string | null>(null);
  const [lastSuccessAt, setLastSuccessAt] = useState<number | null>(null);
  const [failureMessage, setFailureMessage] = useState<string | null>(null);
  const inFlight = useRef(false);

  const authenticated = sessionStatus === 'active';

  const load = useCallback(
    async (target: string) => {
      if (!authenticated || inFlight.current) return;
      inFlight.current = true;
      try {
        const rows = await client.request<ReservationView[]>(
          `/reservations?businessDay=${encodeURIComponent(target)}`,
        );
        setReservations(rows);
        setLoadedDay(target);
        setLastSuccessAt(Date.now());
        setFailureMessage(null);
      } catch (error) {
        if (error instanceof ApiUnreachable) {
          setFailureMessage('The booking system cannot be reached.');
        } else if (error instanceof ApiError) {
          // 401 is already being handled by the client's refresh-and-retry; if
          // it got here the session is gone and the shell will show the login.
          if (error.status !== 401) setFailureMessage(error.message);
        } else {
          setFailureMessage('Something went wrong loading the grid.');
        }
      } finally {
        inFlight.current = false;
      }
    },
    [authenticated, client],
  );

  const refresh = useCallback(() => load(day), [load, day]);

  useEffect(() => {
    void load(day);
  }, [load, day]);

  // Live-ish: a timer while the tab is in front, plus an immediate refetch the
  // moment it comes back. A receptionist switches apps constantly.
  useEffect(() => {
    if (!authenticated) return;

    const tick = (): void => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void load(day);
    };
    const timer = setInterval(tick, POLL_INTERVAL_MS);

    const onVisible = (): void => {
      if (!document.hidden) void load(day);
    };
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onVisible);

    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
    };
  }, [authenticated, load, day]);

  const applyReservation = useCallback((updated: ReservationView) => {
    setReservations((current) => {
      if (!current.some((row) => row.id === updated.id)) {
        return [...current, updated].sort(byStart);
      }
      return current.map((row) => (row.id === updated.id ? { ...row, ...updated } : row));
    });
  }, []);

  // Stale means "this is real data, just not fresh". If the failure happened
  // while moving to a day we have never loaded there is nothing to show at all,
  // which is a different message and a different screen.
  const showingLoadedDay = loadedDay === day;
  const showing = showingLoadedDay ? reservations : [];
  const stale = failureMessage !== null && showingLoadedDay;
  const unavailable = failureMessage !== null && !showingLoadedDay;

  const value = useMemo<ReservationsContextValue>(
    () => ({
      day,
      isToday: day === currentBusinessDay(),
      setDay,
      reservations: showing,
      loading: loadedDay === null && failureMessage === null,
      stale,
      unavailable,
      lastSuccessAt,
      failureMessage,
      // The single gate every write button in the app reads. §12.2.
      writesEnabled: authenticated && failureMessage === null,
      refresh,
      applyReservation,
    }),
    [
      day,
      showing,
      loadedDay,
      stale,
      unavailable,
      lastSuccessAt,
      failureMessage,
      authenticated,
      refresh,
      applyReservation,
    ],
  );

  return <ReservationsContext.Provider value={value}>{children}</ReservationsContext.Provider>;
}

export function useReservations(): ReservationsContextValue {
  const context = useContext(ReservationsContext);
  if (!context) throw new Error('useReservations must be used inside <ReservationsProvider>');
  return context;
}

function byStart(a: ReservationView, b: ReservationView): number {
  return Date.parse(a.startsAt) - Date.parse(b.startsAt);
}
