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
import { ApiClient, ApiUnreachable } from './api-client';
import type { AuthUser, SessionResponse } from './api-types';

/**
 * The session, held in memory for the life of this tab.
 *
 * The access token never leaves `ApiClient`'s private field — not localStorage,
 * not React state that could be serialised into a devtools dump, not a cookie
 * this script can read. What survives a reload is the `brx_rt` HttpOnly cookie,
 * and the first thing this provider does on mount is spend it on a silent
 * refresh. Spec §6.2.
 */

export type SessionStatus = 'loading' | 'anonymous' | 'must-change-password' | 'active';

interface AuthContextValue {
  status: SessionStatus;
  user: AuthUser | null;
  client: ApiClient;
  /** Set when the very first refresh could not reach the API at all. */
  bootstrapOffline: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Refresh a minute before the 15-minute access token runs out. */
const REFRESH_LEAD_MS = 60_000;
const MIN_REFRESH_DELAY_MS = 15_000;

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [client] = useState(() => new ApiClient());
  const [status, setStatus] = useState<SessionStatus>('loading');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [bootstrapOffline, setBootstrapOffline] = useState(false);
  const renewalTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearRenewal = useCallback(() => {
    if (renewalTimer.current !== null) {
      clearTimeout(renewalTimer.current);
      renewalTimer.current = null;
    }
  }, []);

  const adopt = useCallback(
    (session: SessionResponse | null) => {
      clearRenewal();
      if (!session) {
        setUser(null);
        setStatus('anonymous');
        return;
      }
      setUser(session.user);
      setStatus(session.mustChangePassword ? 'must-change-password' : 'active');

      const delay = Math.max(session.expiresIn * 1000 - REFRESH_LEAD_MS, MIN_REFRESH_DELAY_MS);
      renewalTimer.current = setTimeout(() => {
        // A failed renewal on a dead network keeps the session as it is: the
        // next real request will refresh, or fail loudly and stale the screen.
        void client.refresh().catch(() => undefined);
      }, delay);
    },
    [clearRenewal, client],
  );

  // The client tells us when it silently refreshed, or when the server finally
  // refused — both have to move this provider's state.
  useEffect(() => client.onSessionChange(adopt), [client, adopt]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const session = await client.refresh();
        if (!cancelled) adopt(session);
      } catch (error) {
        if (cancelled) return;
        // Unreachable is not signed-out. Say which one it is.
        if (error instanceof ApiUnreachable) setBootstrapOffline(true);
        adopt(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, adopt]);

  useEffect(() => clearRenewal, [clearRenewal]);

  const login = useCallback(
    async (email: string, password: string) => {
      setBootstrapOffline(false);
      adopt(await client.login(email, password));
    },
    [client, adopt],
  );

  const logout = useCallback(async () => {
    try {
      await client.logout();
    } finally {
      adopt(null);
    }
  }, [client, adopt]);

  const changePassword = useCallback(
    async (currentPassword: string, newPassword: string) => {
      adopt(await client.changePassword(currentPassword, newPassword));
    },
    [client, adopt],
  );

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, client, bootstrapOffline, login, logout, changePassword }),
    [status, user, client, bootstrapOffline, login, logout, changePassword],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}
