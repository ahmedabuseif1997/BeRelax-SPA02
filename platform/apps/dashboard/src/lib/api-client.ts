import { ErrorCode } from '@berelax/contracts';
import type { ApiErrorBody } from '@berelax/contracts';
import type { SessionResponse } from './api-types';

/**
 * The one place the dashboard talks to the API.
 *
 * Three things here are load-bearing and should not be "simplified":
 *
 *  1. The access token is a private field on this instance. Not localStorage,
 *     not sessionStorage, not a cookie this script can read. Spec §6.2.
 *  2. A 401 triggers exactly ONE silent refresh + retry, and the retry reuses
 *     the caller's Idempotency-Key, because it is the same attempt at the same
 *     money. A second 401 is a dead session, not a retry loop.
 *  3. A request that never reached the server (offline, DNS, timeout) throws
 *     `ApiUnreachable`, which is a different thing from an error the server
 *     chose to send. The UI degrades on the first and explains the second.
 *     Spec §12.2.
 */

export const API_BASE_URL = (
  process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000/v1'
).replace(/\/+$/, '');

/** The API is on an iPad's patchy Wi-Fi; a hung socket must not hang the desk. */
const REQUEST_TIMEOUT_MS = 12_000;

/** An error the server deliberately sent, in the §3.6 shape. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;
  readonly requestId: string | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
    requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }

  /** A money write that may or may not have landed — retry with the same key. */
  get isInFlight(): boolean {
    return this.code === ErrorCode.REQUEST_IN_PROGRESS;
  }

  get isConflict(): boolean {
    return this.status === 409;
  }
}

/** The request never got an answer. We do not know whether it landed. */
export class ApiUnreachable extends Error {
  readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'ApiUnreachable';
    this.cause = cause;
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Required by the API on every endpoint that moves money. Spec §7.6. */
  idempotencyKey?: string;
  signal?: AbortSignal;
  /** Auth endpoints that must not recurse into the refresh flow. */
  skipAuthRetry?: boolean;
  /** Send no Authorization header at all (login, refresh, public routes). */
  anonymous?: boolean;
}

type SessionListener = (session: SessionResponse | null) => void;

export class ApiClient {
  /** In memory, for the lifetime of this tab. Never persisted. Spec §6.2. */
  private accessToken: string | null = null;

  /** Single-flight: ten 401s during one blackout must cause one refresh. */
  private refreshInFlight: Promise<SessionResponse | null> | null = null;

  private readonly listeners = new Set<SessionListener>();

  setAccessToken(token: string | null): void {
    this.accessToken = token;
  }

  hasAccessToken(): boolean {
    return this.accessToken !== null;
  }

  /** Fires on a silent refresh and on a session that has died. */
  onSessionChange(listener: SessionListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(session: SessionResponse | null): void {
    for (const listener of this.listeners) listener(session);
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.send(path, options);

    if (response.status === 401 && !options.skipAuthRetry && !options.anonymous) {
      // An unreachable API throws out of here rather than resolving to null, so
      // a dropped connection never masquerades as a signed-out session.
      const session = await this.refresh();
      if (!session) {
        this.emit(null);
        throw await toApiError(response);
      }
      // The same attempt, so the same Idempotency-Key: if the first call
      // actually landed before the token expired, the interceptor replays the
      // stored response instead of charging the guest twice. Spec §7.6.
      const retried = await this.send(path, { ...options, skipAuthRetry: true });
      return parse<T>(retried);
    }

    return parse<T>(response);
  }

  /** POST /auth/login — public, and the response seeds the in-memory token. */
  async login(email: string, password: string): Promise<SessionResponse> {
    const session = await this.request<SessionResponse>('/auth/login', {
      method: 'POST',
      body: { email, password },
      anonymous: true,
    });
    this.accessToken = session.accessToken;
    return session;
  }

  /**
   * POST /auth/refresh — the `brx_rt` cookie is the credential, so this carries
   * no Authorization header and relies on `credentials: 'include'`.
   */
  async refresh(): Promise<SessionResponse | null> {
    this.refreshInFlight ??= this.doRefresh().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async doRefresh(): Promise<SessionResponse | null> {
    try {
      const session = await this.request<SessionResponse>('/auth/refresh', {
        method: 'POST',
        anonymous: true,
        skipAuthRetry: true,
      });
      this.accessToken = session.accessToken;
      this.emit(session);
      return session;
    } catch (error) {
      // An unreachable API is not a dead session — do not sign the receptionist
      // out because the Wi-Fi dropped. Only the server saying no counts.
      if (error instanceof ApiUnreachable) throw error;
      this.accessToken = null;
      return null;
    }
  }

  async logout(): Promise<void> {
    try {
      await this.request<void>('/auth/logout', {
        method: 'POST',
        anonymous: true,
        skipAuthRetry: true,
      });
    } finally {
      this.accessToken = null;
      this.emit(null);
    }
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<SessionResponse> {
    const session = await this.request<SessionResponse>('/auth/change-password', {
      method: 'POST',
      body: { currentPassword, newPassword },
      skipAuthRetry: true,
    });
    this.accessToken = session.accessToken;
    this.emit(session);
    return session;
  }

  private async send(path: string, options: RequestOptions): Promise<Response> {
    const headers = new Headers({ Accept: 'application/json' });
    if (options.body !== undefined) headers.set('Content-Type', 'application/json');
    if (options.idempotencyKey) headers.set('Idempotency-Key', options.idempotencyKey);
    if (!options.anonymous && this.accessToken) {
      headers.set('Authorization', `Bearer ${this.accessToken}`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const abortFromCaller = (): void => controller.abort();
    options.signal?.addEventListener('abort', abortFromCaller);

    try {
      return await fetch(`${API_BASE_URL}${path}`, {
        method: options.method ?? 'GET',
        headers,
        // The refresh token is an HttpOnly cookie on the API's origin; without
        // this it is simply never sent and every session dies after 15 minutes.
        credentials: 'include',
        cache: 'no-store',
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new ApiUnreachable(
        'The booking system could not be reached. Check the connection.',
        error,
      );
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abortFromCaller);
    }
  }
}

async function parse<T>(response: Response): Promise<T> {
  if (!response.ok) throw await toApiError(response);
  if (response.status === 204) return undefined as T;

  const text = await response.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiUnreachable('The booking system sent a reply we could not read.');
  }
}

/**
 * Every error the API sends is `{ error: { code, message, details?, requestId } }`
 * and `message` was written to be shown to this person verbatim. Spec §3.6.
 */
async function toApiError(response: Response): Promise<ApiError> {
  let body: ApiErrorBody | null = null;
  try {
    body = (await response.json()) as ApiErrorBody;
  } catch {
    body = null;
  }

  const error = body?.error;
  if (error?.message) {
    return new ApiError(
      response.status,
      String(error.code ?? ErrorCode.INTERNAL_ERROR),
      error.message,
      error.details,
      error.requestId,
    );
  }

  return new ApiError(
    response.status,
    ErrorCode.INTERNAL_ERROR,
    fallbackMessage(response.status),
  );
}

function fallbackMessage(status: number): string {
  if (status === 401) return 'Your session has expired. Sign in again.';
  if (status === 403) return 'Your account cannot perform this action.';
  if (status === 404) return 'That is no longer there. Refresh the grid.';
  if (status >= 500) return 'The booking system is having trouble. Nothing was saved.';
  return 'That did not work.';
}
