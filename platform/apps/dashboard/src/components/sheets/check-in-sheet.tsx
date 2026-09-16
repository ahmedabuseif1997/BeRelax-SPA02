'use client';

import { useCallback, useState } from 'react';
import { PaymentMethod, formatAed } from '@berelax/contracts';
import type { CheckInBody, CheckInView, ReservationView } from '@/lib/api-types';
import { useAuth } from '@/lib/auth-context';
import { useMoneyAction } from '@/lib/idempotency';
import { CASH_SHORTCUTS_FILS, EMPTY_PAD, padFils, type PadValue } from '@/lib/money-pad';
import { useReservations } from '@/lib/reservations-context';
import { dubaiTimeRange } from '@/lib/grid-time';
import { can } from '@/lib/roles';
import { AmountPad } from '../ui/amount-pad';
import { Button } from '../ui/button';
import { ErrorNotice } from '../ui/error-notice';
import { Sheet } from '../ui/sheet';

/**
 * Step 1 of the two-step workflow: the guest arrives and the base service cost
 * is collected UP FRONT. The tip is not decided for another 60 or 90 minutes —
 * that is checkout's job. Spec §8.2.
 *
 * The split must reconcile to the service price EXACTLY. The API refuses
 * anything else with BASE_PAYMENT_MISMATCH, and it is right to: a short payment
 * is a discount taken quietly at the desk. So the remainder is on screen the
 * whole time and Confirm stays dead until it reads zero.
 */

type Field = 'cash' | 'card';

export function CheckInSheet({
  reservation,
  onClose,
  onCheckedIn,
}: {
  reservation: ReservationView;
  onClose: () => void;
  onCheckedIn: (result: CheckInView) => void;
}): JSX.Element {
  const { client, user } = useAuth();
  const { writesEnabled } = useReservations();
  const [cash, setCash] = useState<PadValue>(EMPTY_PAD);
  const [card, setCard] = useState<PadValue>(EMPTY_PAD);
  const [field, setField] = useState<Field>('cash');
  const [comp, setComp] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const due = reservation.baseCostFils;
  const cashFils = padFils(cash);
  const cardFils = padFils(card);
  const takenFils = comp ? due : cashFils + cardFils;
  const remainderFils = due - takenFils;

  const body: CheckInBody = comp
    ? { basePayments: [{ method: PaymentMethod.COMPLIMENTARY, amountFils: due }] }
    : {
        basePayments: [
          ...(cashFils > 0 ? [{ method: PaymentMethod.CASH, amountFils: cashFils }] : []),
          ...(cardFils > 0 ? [{ method: PaymentMethod.CARD, amountFils: cardFils }] : []),
        ],
      };

  const send = useCallback(
    (payload: CheckInBody, idempotencyKey: string) =>
      client.request<CheckInView>(`/reservations/${reservation.id}/check-in`, {
        method: 'POST',
        body: payload,
        // Reception is on patchy Wi-Fi at 01:00. Spec §7.6.
        idempotencyKey,
      }),
    [client, reservation.id],
  );

  const action = useMoneyAction(body, send, setError);

  const balanced = remainderFils === 0 && body.basePayments.length > 0;
  const ready = balanced && writesEnabled;

  const confirm = async (): Promise<void> => {
    setError(null);
    const result = await action.run();
    if (result) onCheckedIn(result);
  };

  const active = field === 'cash' ? cash : card;
  const setActive = (next: PadValue): void => (field === 'cash' ? setCash(next) : setCard(next));

  return (
    <Sheet
      open
      title="Check in"
      subtitle={
        <span>
          {reservation.guest?.fullName ?? 'Walk-in'} · {reservation.service?.name ?? 'Treatment'} ·{' '}
          <span className="numeric">{dubaiTimeRange(reservation.startsAt, reservation.endsAt)}</span>
        </span>
      }
      onClose={onClose}
      busy={action.pending}
      footer={
        <div className="flex items-center gap-3">
          <Button variant="quiet" size="lg" onClick={onClose} disabled={action.pending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="lg"
            block
            disabled={!ready}
            pending={action.pending}
            pendingLabel="Taking payment…"
            onClick={() => void confirm()}
          >
            {comp ? 'Comp and start treatment' : `Take ${formatAed(takenFils)} and start`}
          </Button>
        </div>
      }
    >
      <div className="mb-5 rounded-xl border border-line bg-white px-4 py-3.5">
        <div className="flex items-baseline justify-between">
          <span className="text-[13px] uppercase tracking-label text-ink-muted">Service price</span>
          <span className="font-serif text-[28px] leading-none text-ink numeric">
            {formatAed(due)}
          </span>
        </div>
        <p className="mt-2 border-t border-line pt-2 text-[13px] text-ink-muted">
          Collected before the treatment starts. The tip is recorded at checkout, not now.
        </p>
      </div>

      {!writesEnabled ? (
        <div className="mb-5 rounded-xl border border-alert-line bg-alert-pale px-4 py-3 text-[14px] text-alert-deep">
          Payments are switched off while the booking system is unreachable. Nothing typed here
          would be recorded.
        </div>
      ) : null}

      {comp ? null : (
        <div className="mb-4 grid grid-cols-2 gap-3">
          <MoneyField
            label="Cash"
            amountFils={cashFils}
            active={field === 'cash'}
            onSelect={() => setField('cash')}
          />
          <MoneyField
            label="Card"
            amountFils={cardFils}
            active={field === 'card'}
            onSelect={() => setField('card')}
          />
        </div>
      )}

      <Remainder dueFils={due} takenFils={takenFils} comp={comp} />

      {comp ? null : (
        <div className="mt-4">
          <AmountPad
            value={active}
            onChange={setActive}
            shortcuts={CASH_SHORTCUTS_FILS}
            // "Exact" fills the active field with whatever is still owed, so a
            // split is two taps: 100 on cash, Exact on card.
            exactFils={Math.max(remainderFils + padFils(active), 0)}
            disabled={!writesEnabled}
          />
        </div>
      )}

      {can(user?.role, 'payment.comp') ? (
        <div className="mt-5 rounded-xl border border-line bg-white px-4 py-3">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={comp}
              onChange={(event) => {
                setComp(event.target.checked);
                setCash(EMPTY_PAD);
                setCard(EMPTY_PAD);
              }}
              className="mt-1 h-5 w-5 flex-none accent-teal-700"
            />
            <span className="text-[14px] leading-snug text-ink">
              Complimentary
              <span className="mt-0.5 block text-[13px] text-ink-muted">
                Manager only, and it has to be the whole bill — a part-comp is a discount, which is
                an adjustment a manager signs for.
              </span>
            </span>
          </label>
        </div>
      ) : null}

      {error ? (
        <div className="mt-5">
          <ErrorNotice
            error={error}
            onRetry={() => void confirm()}
            // Same attempt, same Idempotency-Key: a retry cannot double-charge.
            retryLabel="Send again"
          />
        </div>
      ) : null}
    </Sheet>
  );
}

function MoneyField({
  label,
  amountFils,
  active,
  onSelect,
}: {
  label: string;
  amountFils: number;
  active: boolean;
  onSelect: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={[
        'rounded-xl border px-4 py-3 text-left transition-colors',
        active ? 'border-teal-600 bg-teal-50 ring-4 ring-teal-500/15' : 'border-line bg-white',
      ].join(' ')}
    >
      <span className="block text-[11.5px] uppercase tracking-label text-ink-muted">{label}</span>
      <span className="mt-0.5 block font-serif text-[24px] leading-none text-ink numeric">
        {formatAed(amountFils)}
      </span>
    </button>
  );
}

function Remainder({
  dueFils,
  takenFils,
  comp,
}: {
  dueFils: number;
  takenFils: number;
  comp: boolean;
}): JSX.Element {
  const remainder = dueFils - takenFils;

  if (comp) {
    return (
      <p className="rounded-xl border border-gold-light bg-gold-pale px-4 py-3 text-[14px] text-gold-deep">
        The full {formatAed(dueFils)} is being comped. Nothing is collected.
      </p>
    );
  }

  if (remainder === 0 && takenFils > 0) {
    return (
      <p className="rounded-xl border border-teal-300 bg-teal-50 px-4 py-3 text-[15px] font-medium text-teal-700">
        Balanced — {formatAed(takenFils)} of {formatAed(dueFils)}.
      </p>
    );
  }

  if (remainder < 0) {
    return (
      <p className="rounded-xl border border-alert-line bg-alert-pale px-4 py-3 text-[15px] font-medium text-alert-deep numeric">
        Over by {formatAed(-remainder)} — the total has to match the price exactly.
      </p>
    );
  }

  return (
    <p className="rounded-xl border border-line bg-white px-4 py-3 text-[15px] text-ink numeric">
      Still to collect <strong className="font-medium">{formatAed(remainder)}</strong>
    </p>
  );
}
