'use client';

import { useState, type ReactNode } from 'react';
import { formatAed } from '@berelax/contracts';
import type { ReservationView } from '@/lib/api-types';
import { useAuth } from '@/lib/auth-context';
import { dubaiTime, dubaiTimeRange, needsCheckout, overdueBy } from '@/lib/grid-time';
import { useReservations } from '@/lib/reservations-context';
import { can } from '@/lib/roles';
import { Button } from '../ui/button';
import { ErrorNotice } from '../ui/error-notice';
import { Sheet } from '../ui/sheet';
import { NeedsCheckoutPill, StatusPill } from '../ui/status';

/**
 * What the desk sees when it taps a booking: the facts, then the one or two
 * things that can be done to it from here. Actions the API would refuse are not
 * rendered at all — a receptionist should never meet a 403 they could have been
 * spared. Spec §6.4.
 */
export function ReservationSheet({
  reservation,
  onClose,
  onCheckIn,
  onCheckout,
}: {
  reservation: ReservationView;
  onClose: () => void;
  onCheckIn: () => void;
  onCheckout: () => void;
}): JSX.Element {
  const { client, user } = useAuth();
  const { writesEnabled, applyReservation, refresh } = useReservations();
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState<'no-show' | 'cancel' | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');

  const overdue = needsCheckout(reservation);
  const isScheduled = reservation.status === 'SCHEDULED';
  const isInProgress = reservation.status === 'IN_PROGRESS';

  const mayCancel = isInProgress
    ? can(user?.role, 'reservation.cancelInProgress')
    : isScheduled && can(user?.role, 'reservation.cancelScheduled');

  const act = async (
    kind: 'no-show' | 'cancel',
    body?: Record<string, unknown>,
  ): Promise<void> => {
    if (pending) return;
    setPending(kind);
    setError(null);
    try {
      // Neither of these moves money, so neither carries an Idempotency-Key —
      // the API marks only check-in and checkout @Idempotent.
      const updated = await client.request<ReservationView>(
        `/reservations/${reservation.id}/${kind}`,
        { method: 'POST', ...(body ? { body } : {}) },
      );
      applyReservation(updated);
      void refresh();
      onClose();
    } catch (actionError) {
      setError(actionError);
    } finally {
      setPending(null);
    }
  };

  return (
    <Sheet
      open
      title={reservation.guest?.fullName ?? 'Walk-in'}
      subtitle={
        <span className="flex flex-wrap items-center gap-2">
          <StatusPill status={reservation.status} />
          {overdue ? <NeedsCheckoutPill overdue={overdueBy(reservation)} /> : null}
          <span className="numeric text-ink-muted">{reservation.ref}</span>
        </span>
      }
      onClose={onClose}
      busy={pending !== null}
      footer={
        <div className="grid gap-2.5">
          {isScheduled && can(user?.role, 'reservation.checkIn') ? (
            <Button
              variant="primary"
              size="xl"
              block
              disabled={!writesEnabled}
              onClick={onCheckIn}
            >
              Check in · take {formatAed(reservation.baseCostFils)}
            </Button>
          ) : null}

          {isInProgress && can(user?.role, 'reservation.checkout') ? (
            <Button
              variant="primary"
              size="xl"
              block
              disabled={!writesEnabled}
              onClick={onCheckout}
            >
              Check out
            </Button>
          ) : null}

          <div className="flex gap-2.5">
            {isScheduled && can(user?.role, 'reservation.noShow') ? (
              <Button
                variant="secondary"
                size="lg"
                block
                disabled={!writesEnabled}
                pending={pending === 'no-show'}
                onClick={() => void act('no-show')}
              >
                No-show
              </Button>
            ) : null}

            {mayCancel ? (
              <Button
                variant="secondary"
                size="lg"
                block
                disabled={!writesEnabled}
                onClick={() => setCancelling((open) => !open)}
              >
                Cancel booking
              </Button>
            ) : null}
          </div>
        </div>
      }
    >
      <dl className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-white">
        <Row label="Time">
          <span className="numeric">
            {dubaiTimeRange(reservation.startsAt, reservation.endsAt)}
          </span>
          <span className="ml-2 text-ink-muted">({reservation.durationMinutes} min)</span>
        </Row>
        <Row label="Trading day">
          <span className="numeric">{reservation.businessDay}</span>
          <span className="ml-2 text-[13px] text-ink-muted">
            slot held until {dubaiTime(reservation.blockedUntil)}
          </span>
        </Row>
        <Row label="Therapist">{reservation.employee?.displayName ?? '—'}</Row>
        <Row label="Service">{reservation.service?.name ?? '—'}</Row>
        <Row label="Room">{reservation.room?.name ?? 'Not assigned'}</Row>
        <Row label="Price">
          <span className="numeric">{formatAed(reservation.baseCostFils)}</span>
        </Row>
        {reservation.guest?.phone ? (
          <Row label="Phone">
            <a href={`tel:${reservation.guest.phone}`} className="text-teal-700 numeric">
              {reservation.guest.phone}
            </a>
          </Row>
        ) : null}
        <Row label="Booked via">{reservation.sourceChannel.replace(/_/g, ' ').toLowerCase()}</Row>
        {reservation.actualArrivalAt ? (
          <Row label="Arrived">
            <span className="numeric">{dubaiTime(reservation.actualArrivalAt)}</span>
          </Row>
        ) : null}
        {reservation.completedAt ? (
          <Row label="Finished">
            <span className="numeric">{dubaiTime(reservation.completedAt)}</span>
          </Row>
        ) : null}
        {reservation.cancellationReason ? (
          <Row label="Cancelled because">{reservation.cancellationReason}</Row>
        ) : null}
        {reservation.notes ? <Row label="Notes">{reservation.notes}</Row> : null}
      </dl>

      {overdue ? (
        <p className="mt-4 rounded-xl border border-alert-line bg-alert-pale px-4 py-3 text-[14px] leading-snug text-alert-deep">
          This treatment finished {overdueBy(reservation)} ago and is still open. Check it out so
          tonight&apos;s takings are right.
        </p>
      ) : null}

      {cancelling ? (
        <div className="mt-5 rounded-xl border border-line bg-white p-4">
          <label className="field-label" htmlFor="cancel-reason">
            Why is it being cancelled?
          </label>
          <input
            id="cancel-reason"
            className="field-input"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Guest called to cancel"
            maxLength={300}
          />
          <p className="mt-2 text-[13px] text-ink-muted">
            The reason is kept on the booking. Money already taken is not refunded here — a refund
            is a separate entry a manager raises.
          </p>
          <Button
            variant="danger"
            size="lg"
            block
            className="mt-3"
            disabled={reason.trim().length < 3 || !writesEnabled}
            pending={pending === 'cancel'}
            onClick={() => void act('cancel', { reason: reason.trim() })}
          >
            Cancel this booking
          </Button>
        </div>
      ) : null}

      {error ? (
        <div className="mt-5">
          <ErrorNotice error={error} />
        </div>
      ) : null}
    </Sheet>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-4 px-4 py-3">
      <dt className="flex-none text-[12px] uppercase tracking-label text-ink-muted">{label}</dt>
      <dd className="min-w-0 text-right text-[15px] text-ink">{children}</dd>
    </div>
  );
}
