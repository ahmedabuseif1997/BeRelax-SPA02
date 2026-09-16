'use client';

import { useCallback, useEffect, useState } from 'react';
import type {
  AvailabilityView,
  EmployeeSummary,
  RoomSummary,
  ServiceSummary,
} from './api-types';
import { useAuth } from './auth-context';

/**
 * The treatment menu, the rooms and tonight's therapists.
 *
 * Which endpoint each of these comes from is a role question, not a convenience
 * one (§6.4):
 *
 *  - `GET /services` and `GET /rooms` override their controller's MANAGER+ class
 *    guard with `@Roles(...ALL_STAFF)` on the list routes, because reception
 *    cannot price a booking without the menu. A price list is not a revenue
 *    total, and what §6.4 keeps from the desk is the takings.
 *  - The therapist roster comes from `GET /availability`, NOT `GET /employees`.
 *    `/employees` is MANAGER+ with no override, so a receptionist would get a
 *    403 — while `/availability` is ALL_STAFF and carries no guest, no money and
 *    no booking ids, only who is on shift. It is also the better list: the grid
 *    wants who is working tonight, not every active employee.
 *
 * Everything here fails soft. A roster that will not load leaves the grid to
 * build its columns from the day's bookings; a menu that will not load disables
 * the New booking sheet with an honest reason. Neither takes the grid, check-in
 * or checkout down with it. Spec §12.2.
 */

export interface Catalogue {
  services: ServiceSummary[];
  rooms: RoomSummary[];
  /** On shift for the trading day this was asked about. */
  therapists: EmployeeSummary[];
  loading: boolean;
  /** Null when everything needed to take a booking is present. */
  unavailableReason: string | null;
  reload: () => void;
}

/** A list route may answer with a bare array or `{ data: [...] }`. Accept both. */
function unwrapList<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === 'object' && 'data' in payload) {
    const data = (payload as { data: unknown }).data;
    if (Array.isArray(data)) return data as T[];
  }
  return [];
}

export function useCatalogue(day: string): Catalogue {
  const { client, status } = useAuth();
  const [services, setServices] = useState<ServiceSummary[]>([]);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [therapists, setTherapists] = useState<EmployeeSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  // A 403 (not this role's to read), a 404 (not deployed) and an unreachable
  // API are all "carry on without it".
  const softGet = useCallback(
    async <T,>(path: string): Promise<T | null> => {
      try {
        return await client.request<T>(path);
      } catch {
        return null;
      }
    },
    [client],
  );

  // The menu and the rooms do not change between trading days.
  useEffect(() => {
    if (status !== 'active') return;
    let cancelled = false;

    void (async () => {
      setLoading(true);
      const [menu, treatmentRooms] = await Promise.all([
        softGet<unknown>('/services'),
        softGet<unknown>('/rooms'),
      ]);
      if (cancelled) return;
      setServices(unwrapList<ServiceSummary>(menu).filter((s) => s.isActive !== false));
      setRooms(unwrapList<RoomSummary>(treatmentRooms).filter((r) => r.isActive !== false));
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [softGet, status, nonce]);

  // The roster does: it is per trading day.
  useEffect(() => {
    if (status !== 'active') return;
    let cancelled = false;

    void (async () => {
      const availability = await softGet<AvailabilityView>(
        `/availability?businessDay=${encodeURIComponent(day)}`,
      );
      if (cancelled) return;
      const roster = availability?.therapists ?? [];
      setTherapists(
        roster.map((entry) => ({
          id: entry.employeeId,
          displayName: entry.displayName,
          status: entry.shift.status,
        })),
      );
    })();

    return () => {
      cancelled = true;
    };
  }, [softGet, status, day, nonce]);

  const unavailableReason =
    loading || services.length > 0
      ? null
      : 'The treatment menu did not load, so a new booking cannot be priced. The grid, check-in and checkout are unaffected.';

  return { services, rooms, therapists, loading, unavailableReason, reload };
}
