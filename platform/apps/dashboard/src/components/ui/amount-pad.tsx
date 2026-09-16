'use client';

import { formatAed } from '@berelax/contracts';
import {
  EMPTY_PAD,
  padDisplay,
  padFils,
  padFromFils,
  padPress,
  type PadKey,
  type PadValue,
} from '@/lib/money-pad';

/**
 * A till keypad. Digits fill from the right in fils, exactly like a card
 * terminal: 2,5,0,0,0 reads AED 250.00. There is no decimal key, because there
 * is no float anywhere in this path. Spec §3.1.
 */

const KEYS: readonly PadKey[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0', 'backspace'];

export function AmountPad({
  value,
  onChange,
  shortcuts = [],
  exactFils,
  disabled = false,
}: {
  value: PadValue;
  onChange: (next: PadValue) => void;
  /** Common notes, in fils. Tapping one adds it to what is already entered. */
  shortcuts?: readonly number[];
  /** "Exact" fills the pad with the amount still owed. */
  exactFils?: number;
  disabled?: boolean;
}): JSX.Element {
  const press = (key: PadKey): void => onChange(padPress(value, key));

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-2">
        {exactFils !== undefined && exactFils > 0 ? (
          <PadChip
            label={`Exact · ${formatAed(exactFils)}`}
            onClick={() => onChange(padFromFils(exactFils))}
            disabled={disabled}
            emphasis
          />
        ) : null}
        {shortcuts.map((fils) => (
          <PadChip
            key={fils}
            label={`+ ${formatAed(fils)}`}
            // Adding, not replacing: a guest hands over two 50s and a 20.
            onClick={() => onChange(padFromFils(padFils(value) + fils))}
            disabled={disabled}
          />
        ))}
        <PadChip label="Clear" onClick={() => onChange(EMPTY_PAD)} disabled={disabled} />
      </div>

      <div
        aria-live="polite"
        className="mb-3 rounded-xl border border-line bg-white px-4 py-3 text-right font-serif text-[34px] leading-none text-ink numeric"
      >
        {padDisplay(value)}
      </div>

      <div className="grid grid-cols-3 gap-2">
        {KEYS.map((key) => (
          <button
            key={key}
            type="button"
            disabled={disabled}
            onClick={() => press(key)}
            aria-label={key === 'backspace' ? 'Delete last digit' : key}
            className="min-h-[60px] rounded-xl border border-line bg-white text-[22px] font-medium
                       text-ink transition-colors active:bg-oat disabled:opacity-40
                       hover:border-line-strong numeric"
          >
            {key === 'backspace' ? '⌫' : key}
          </button>
        ))}
      </div>
    </div>
  );
}

function PadChip({
  label,
  onClick,
  disabled,
  emphasis = false,
}: {
  label: string;
  onClick: () => void;
  disabled: boolean;
  emphasis?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={[
        'min-h-[44px] rounded-full border px-4 text-[13.5px] font-medium transition-colors disabled:opacity-40',
        emphasis
          ? 'border-teal-500 bg-teal-50 text-teal-700 hover:bg-teal-100'
          : 'border-line bg-white text-ink-muted hover:border-line-strong hover:text-ink',
      ].join(' ')}
    >
      {label}
    </button>
  );
}
