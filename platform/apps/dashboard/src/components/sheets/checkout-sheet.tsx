'use client';

import { useCallback, useState } from 'react';
import { ErrorCode, PaymentMethod, TipType, formatAed } from '@berelax/contracts';
import { ApiError } from '@/lib/api-client';
import type { CheckoutBody, CheckoutView, ReservationView } from '@/lib/api-types';
import { useAuth } from '@/lib/auth-context';
import { dubaiTimeRange } from '@/lib/grid-time';
import { useMoneyAction } from '@/lib/idempotency';
import { EMPTY_PAD, TIP_SHORTCUTS_FILS, padFils, type PadValue } from '@/lib/money-pad';
import { useReservations } from '@/lib/reservations-context';
import { can } from '@/lib/roles';
import { AmountPad } from '../ui/amount-pad';
import { Button } from '../ui/button';
import { ErrorNotice } from '../ui/error-notice';
import { Sheet } from '../ui/sheet';

/**
 * Step 2: the treatment is over and the tip — if there is one — is recorded now.
 *
 * Two taps, not a form (spec §8.4). No tip is the default and needs one
 * confirming tap, because a checkout that is easy to skip is a checkout that
 * gets skipped, and a booking left IN_PROGRESS overnight is a wrong report
 * tomorrow.
 *
 * The distinction between the other two buttons is the whole design (§9.1):
 * cash handed to the therapist never entered the till, so the business owes
 * nothing and the tip carries no payment method. A tip added to the bill enters
 * the till, and the business now owes it.
 */

type Mode = 'none' | 'direct' | 'billed';

export function CheckoutSheet({
  reservation,
  onClose,
  onCheckedOut,
}: {
  reservation: ReservationView;
  onClose: () => void;
  onCheckedOut: (result: CheckoutView) => void;
}): JSX.Element {
  const { client, user } = useAuth();
  const { writesEnabled } = useReservations();
  const [mode, setMode] = useState<Mode>('none');
  const [pad, setPad] = useState<PadValue>(EMPTY_PAD);
  const [method, setMethod] = useState<PaymentMethod>(PaymentMethod.CARD);
  const [confirmLargeTip, setConfirmLargeTip] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const tipFils = padFils(pad);

  const body: CheckoutBody = buildBody(mode, tipFils, method, confirmLargeTip);

  const send = useCallback(
    (payload: CheckoutBody, idempotencyKey: string) =>
      client.request<CheckoutView>(`/reservations/${reservation.id}/checkout`, {
        method: 'POST',
        body: payload,
        idempotencyKey,
      }),
    [client, reservation.id],
  );

  const action = useMoneyAction(body, send, setError);

  const submit = async (): Promise<void> => {
    setError(null);
    const result = await action.run();
    if (result) onCheckedOut(result);
  };

  const tooLarge =
    error instanceof ApiError && error.code === ErrorCode.TIP_EXCEEDS_SANITY_LIMIT;
  const canOverride = can(user?.role, 'tip.confirmLarge');
  const tipReady = mode === 'none' || tipFils > 0;

  return (
    <Sheet
      open
      title="Checkout"
      subtitle={
        <span>
          {reservation.guest?.fullName ?? 'Walk-in'} · {reservation.employee?.displayName ?? '—'} ·{' '}
          <span className="numeric">{dubaiTimeRange(reservation.startsAt, reservation.endsAt)}</span>
        </span>
      }
      onClose={onClose}
      busy={action.pending}
      footer={
        <Button
          variant="primary"
          size="xl"
          block
          disabled={!writesEnabled || !tipReady}
          pending={action.pending}
          pendingLabel="Closing the booking…"
          onClick={() => void submit()}
        >
          {confirmLabel(mode, tipFils)}
        </Button>
      }
    >
      {!writesEnabled ? (
        <div className="mb-5 rounded-xl border border-alert-line bg-alert-pale px-4 py-3 text-[14px] text-alert-deep">
          Checkout is switched off while the booking system is unreachable. Nothing here would be
          recorded.
        </div>
      ) : null}

      <div className="mb-5 flex items-baseline justify-between rounded-xl border border-line bg-white px-4 py-3">
        <span className="text-[13px] uppercase tracking-label text-ink-muted">Already paid</span>
        <span className="font-serif text-[24px] leading-none text-ink numeric">
          {formatAed(reservation.baseCostFils)}
        </span>
      </div>

      <p className="eyebrow mb-3">Tip</p>

      <div className="grid gap-2.5">
        <TipChoice
          selected={mode === 'none'}
          onSelect={() => {
            setMode('none');
            setPad(EMPTY_PAD);
            setConfirmLargeTip(false);
          }}
          title="No tip"
          detail="The usual. One tap closes the booking."
        />
        <TipChoice
          selected={mode === 'direct'}
          onSelect={() => setMode('direct')}
          title="Cash to therapist"
          detail="The guest handed it over. It never entered the till, so the business owes nothing — it still counts as the therapist's earnings."
        />
        <TipChoice
          selected={mode === 'billed'}
          onSelect={() => setMode('billed')}
          title="Added to bill"
          detail="The business holds it and now owes the therapist. Goes on the payout ledger."
        />
      </div>

      {mode === 'billed' ? (
        <div className="mt-5">
          <p className="field-label">Paid by</p>
          <div className="grid grid-cols-2 gap-2.5">
            {[PaymentMethod.CASH, PaymentMethod.CARD].map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setMethod(option)}
                className={[
                  'min-h-[54px] rounded-xl border px-4 text-[15px] font-medium transition-colors',
                  method === option
                    ? 'border-teal-600 bg-teal-50 text-teal-700 ring-4 ring-teal-500/15'
                    : 'border-line bg-white text-ink',
                ].join(' ')}
              >
                {option === PaymentMethod.CASH ? 'Cash' : 'Card'}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {mode === 'none' ? null : (
        <div className="mt-5">
          <AmountPad
            value={pad}
            onChange={(next) => {
              setPad(next);
              // A changed amount is a new attempt, so the manager override does
              // not silently carry over to a different number.
              setConfirmLargeTip(false);
            }}
            shortcuts={TIP_SHORTCUTS_FILS}
            disabled={!writesEnabled}
          />
        </div>
      )}

      {error ? (
        <div className="mt-5">
          <ErrorNotice error={error} onRetry={() => void submit()} retryLabel="Send again" />
          {tooLarge && canOverride && !confirmLargeTip ? (
            <Button
              variant="secondary"
              size="lg"
              block
              className="mt-3"
              onClick={() => {
                setConfirmLargeTip(true);
                setError(null);
              }}
            >
              I have checked it — confirm {formatAed(tipFils)}
            </Button>
          ) : null}
          {tooLarge && !canOverride ? (
            <p className="mt-3 text-[13.5px] text-ink-muted">
              Change the amount, or ask a manager to confirm it.
            </p>
          ) : null}
        </div>
      ) : null}

      {confirmLargeTip ? (
        <p className="mt-3 rounded-xl border border-gold-light bg-gold-pale px-4 py-3 text-[13.5px] text-gold-deep">
          Manager override is on for {formatAed(tipFils)}. Send it again to record it.
        </p>
      ) : null}
    </Sheet>
  );
}

/**
 * `tip: null` is a fully recorded, perfectly valid outcome — most checkouts
 * have no tip. A DIRECT_CASH tip must carry NO method: the money never touched
 * the till, and the API rejects one with TIP_METHOD_NOT_ALLOWED.
 */
function buildBody(
  mode: Mode,
  tipFils: number,
  method: PaymentMethod,
  confirmLargeTip: boolean,
): CheckoutBody {
  if (mode === 'none' || tipFils <= 0) return { tip: null };
  if (mode === 'direct') {
    return {
      tip: { amountFils: tipFils, type: TipType.DIRECT_CASH },
      ...(confirmLargeTip ? { confirmLargeTip: true } : {}),
    };
  }
  return {
    tip: { amountFils: tipFils, type: TipType.COLLECTED_BY_BUSINESS, method },
    ...(confirmLargeTip ? { confirmLargeTip: true } : {}),
  };
}

function confirmLabel(mode: Mode, tipFils: number): string {
  if (mode === 'none') return 'No tip — finish';
  if (tipFils <= 0) return 'Enter the tip amount';
  return mode === 'direct'
    ? `Record ${formatAed(tipFils)} cash to therapist`
    : `Add ${formatAed(tipFils)} to the bill`;
}

function TipChoice({
  selected,
  onSelect,
  title,
  detail,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  detail: string;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={[
        'min-h-[68px] rounded-xl border px-4 py-3 text-left transition-colors',
        selected
          ? 'border-teal-600 bg-teal-50 ring-4 ring-teal-500/15'
          : 'border-line bg-white hover:border-line-strong',
      ].join(' ')}
    >
      <span className="block text-[17px] font-medium text-ink">{title}</span>
      <span className="mt-0.5 block text-[13px] leading-snug text-ink-muted">{detail}</span>
    </button>
  );
}
