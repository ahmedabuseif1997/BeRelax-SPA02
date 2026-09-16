'use client';

import type { ButtonHTMLAttributes, ReactNode } from 'react';

/**
 * Every button on this screen is pressed by a thumb, on an iPad, at arm's
 * length, sometimes at 01:00. The smallest variant is still 44px tall.
 */

type Variant = 'primary' | 'secondary' | 'quiet' | 'danger';
type Size = 'md' | 'lg' | 'xl';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /** Shown in place of the label while a request is in the air. */
  pending?: boolean;
  pendingLabel?: string;
  block?: boolean;
  children: ReactNode;
}

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-teal-700 text-white border-teal-700 hover:bg-teal-600 active:bg-teal-900 shadow-sm',
  secondary:
    'bg-white text-ink border-line-strong hover:border-teal-500 hover:bg-teal-50 active:bg-teal-100',
  quiet: 'bg-transparent text-ink-muted border-transparent hover:bg-oat active:bg-oat-dark',
  danger: 'bg-alert text-white border-alert hover:bg-alert-deep active:bg-alert-deep shadow-sm',
};

const SIZES: Record<Size, string> = {
  md: 'min-h-[44px] px-4 text-[14px]',
  lg: 'min-h-[54px] px-6 text-[15px]',
  xl: 'min-h-[68px] px-6 text-[17px]',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  pending = false,
  pendingLabel,
  block = false,
  className = '',
  disabled,
  children,
  ...rest
}: ButtonProps): JSX.Element {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled === true || pending}
      className={[
        'inline-flex items-center justify-center gap-2 rounded-xl border font-medium',
        'transition-colors duration-150 select-none',
        'disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-inherit',
        VARIANTS[variant],
        SIZES[size],
        block ? 'w-full' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {pending ? (
        <>
          <Spinner />
          {pendingLabel ?? 'Working…'}
        </>
      ) : (
        children
      )}
    </button>
  );
}

export function Spinner(): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent opacity-70"
    />
  );
}
