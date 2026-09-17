'use client';

import { formatAed } from '@berelax/contracts';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { ErrorNotice } from '@/components/ui/error-notice';
import { padDisplay, padFils, type PadValue } from '@/lib/money-pad';
import type { CheckLine, SubmitReconciliationBody } from './types';

/**
 * What the paper says, typed in before the screen is read.
 *
 * TWO RULES SHAPE THIS FORM.
 *
 * It never shows the system's figure beside its own field. The whole pilot
 * rests on somebody counting the drawer and reading the Z-report independently;
 * a form that prints the expected answer next to the box turns a control into a
 * copying exercise, and a fortnight of matched nights would prove nothing at
 * all. The sheet with the system's figures is on the same page, below — and the
 * instruction to count first is said out loud rather than assumed.
 *
 * It cannot accept a decimal. Every money field is a run of digit characters
 * accumulated in FILS, exactly like the till pad reception already uses (§3.1):
 * 1,8,4,0,0,0 reads AED 1,840.00. There is no `parseFloat` in this file and no
 * decimal key to press, because a rounding error here is a real variance that
 * somebody will spend an hour of their night looking for.
 */

interface Draft {
  cash: PadValue;
  card: PadValue;
  bookings: string;
  tips: PadValue;
  note: string;
}

const EMPTY: Draft = {
  cash: { digits: '' },
  card: { digits: '' },
  bookings: '',
  tips: { digits: '' },
  note: '',
};

/** Digits only, leading zeros collapsed, capped where the till pad caps. */
function digitsOnly(raw: string, max = 9): string {
  return raw.replace(/\D/g, '').slice(0, max).replace(/^0+(?=\d)/, '');
}

export function PaperForm({
  businessDay,
  toCheck,
  onSubmit,
  pending,
  error,
  onDismissError,
}: {
  businessDay: string;
  /** The tick-list from the sheet. The form has exactly these fields. */
  toCheck: CheckLine[];
  onSubmit: (body: SubmitReconciliationBody) => void;
  pending: boolean;
  error: unknown;
  onDismissError: () => void;
}): JSX.Element {
  const [draft, setDraft] = useState<Draft>(EMPTY);

  const from = (key: string): string =>
    toCheck.find((line) => line.key === key)?.from ?? '';

  // Required means required: a night cannot be certified on a drawer nobody
  // counted. An empty box is not a zero — a zero is a claim somebody made.
  const ready =
    draft.cash.digits !== '' && draft.card.digits !== '' && draft.bookings !== '';

  const submit = (): void => {
    if (!ready || pending) return;
    const note = draft.note.trim();
    const tips = draft.tips.digits;
    onSubmit({
      countedCashFils: padFils(draft.cash),
      paperCardTotalFils: padFils(draft.card),
      paperBookings: Number.parseInt(draft.bookings, 10),
      ...(tips === '' ? {} : { paperTipsCashFils: padFils(draft.tips) }),
      ...(note === '' ? {} : { note }),
    });
  };

  return (
    <section className="rounded-xl border-2 border-line-strong bg-white">
      <header className="border-b border-line px-4 py-3.5 sm:px-5">
        <p className="eyebrow mb-1.5">Step one</p>
        <h2 className="font-serif text-[21px] leading-tight text-ink">
          What the paper says
        </h2>
        <p className="mt-1.5 max-w-[60ch] text-[13.5px] leading-snug text-ink-muted">
          Count the drawer and tear off the Z-report <strong>before</strong> you read the
          close-out sheet below. Fill these in from the paper and the till — not from the
          screen. A figure copied off the system proves nothing about the night.
        </p>
      </header>

      <div className="grid gap-4 px-4 py-4 sm:px-5">
        <FilsField
          label="Cash counted in the drawer"
          hint={from('CASH')}
          value={draft.cash}
          onChange={(cash) => setDraft((d) => ({ ...d, cash }))}
          disabled={pending}
        />
        <FilsField
          label="Card terminal Z-report total"
          hint={from('CARD')}
          value={draft.card}
          onChange={(card) => setDraft((d) => ({ ...d, card }))}
          disabled={pending}
        />

        <label>
          <span className="field-label">Sessions on the paper sheet</span>
          <input
            inputMode="numeric"
            autoComplete="off"
            value={draft.bookings}
            onChange={(event) =>
              setDraft((d) => ({ ...d, bookings: digitsOnly(event.target.value, 4) }))
            }
            disabled={pending}
            className="field-input numeric"
            placeholder="0"
          />
          <span className="mt-1.5 block text-[12.5px] leading-snug text-ink-muted">
            {from('BOOKINGS')}
          </span>
        </label>

        <FilsField
          label="Cash tips handed straight to therapists"
          hint={from('TIPS_DIRECT_CASH')}
          optional
          value={draft.tips}
          onChange={(tips) => setDraft((d) => ({ ...d, tips }))}
          disabled={pending}
        />

        <label>
          <span className="field-label">Anything unusual about the night (optional)</span>
          <textarea
            value={draft.note}
            maxLength={500}
            rows={2}
            onChange={(event) => setDraft((d) => ({ ...d, note: event.target.value }))}
            disabled={pending}
            className="field-input resize-none"
            placeholder="one walk-in paid half cash half card"
          />
          <span className="mt-1.5 block text-[12.5px] leading-snug text-ink-muted">
            A note does not excuse a difference. If every figure agrees, the night still
            counts towards the five — it is recorded as matched, with the note attached.
          </span>
        </label>

        {error ? (
          <ErrorNotice error={error} onRetry={onDismissError} retryLabel="Start again" />
        ) : null}

        <Button
          variant="primary"
          size="lg"
          block
          disabled={!ready}
          pending={pending}
          pendingLabel="Comparing…"
          onClick={submit}
        >
          Compare with the system
        </Button>

        {!ready ? (
          <p className="text-center text-[12.5px] text-ink-muted">
            The drawer, the terminal total and the session count are all needed. Leaving one
            blank is not the same as it being zero.
          </p>
        ) : (
          <p className="text-center text-[12.5px] text-ink-muted">
            Reconciling {businessDay}. Nothing is changed by this — it records what both
            sides said.
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * A money field in fils. Digits accumulate from the right the way the till pad
 * does, and the AED reading underneath is the only place the value is ever
 * rendered as a decimal — on the way out, never on the way in.
 */
function FilsField({
  label,
  hint,
  value,
  onChange,
  disabled,
  optional = false,
}: {
  label: string;
  hint: string;
  value: PadValue;
  onChange: (next: PadValue) => void;
  disabled: boolean;
  optional?: boolean;
}): JSX.Element {
  return (
    <label>
      <span className="field-label">
        {label}
        {optional ? <span className="ml-1.5 normal-case tracking-normal">· optional</span> : null}
      </span>
      <div className="flex items-stretch gap-2">
        <input
          inputMode="numeric"
          autoComplete="off"
          value={value.digits}
          onChange={(event) => onChange({ digits: digitsOnly(event.target.value) })}
          disabled={disabled}
          className="field-input numeric"
          placeholder="0"
          aria-describedby={`${label}-reading`}
        />
        <output
          id={`${label}-reading`}
          className="flex min-w-[130px] items-center justify-end rounded-xl border border-line bg-oat-light px-3 text-[15px] text-ink numeric"
        >
          {value.digits === '' ? formatAed(0) : padDisplay(value)}
        </output>
      </div>
      <span className="mt-1.5 block text-[12.5px] leading-snug text-ink-muted">
        {hint} Type whole fils — 184000 reads {formatAed(184_000)}.
      </span>
    </label>
  );
}
