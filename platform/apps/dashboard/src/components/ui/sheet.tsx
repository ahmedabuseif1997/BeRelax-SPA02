'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/**
 * A panel that slides in from the right on a landscape iPad and up from the
 * bottom on a narrow one. It cannot be dismissed while a write is in the air —
 * closing a sheet mid-payment is how a receptionist ends up unsure whether the
 * money went through.
 */
export function Sheet({
  open,
  title,
  subtitle,
  onClose,
  busy = false,
  footer,
  children,
}: {
  open: boolean;
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  busy?: boolean;
  footer?: ReactNode;
  children: ReactNode;
}): JSX.Element | null {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, busy, onClose]);

  useEffect(() => {
    if (open) panel.current?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-end sm:items-stretch">
      <button
        type="button"
        aria-label="Close"
        disabled={busy}
        onClick={onClose}
        className="absolute inset-0 bg-ink/35 backdrop-blur-[2px] disabled:cursor-not-allowed"
      />

      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="relative flex h-[92vh] w-full flex-col rounded-t-sheet bg-cream shadow-sheet
                   outline-none sm:h-full sm:w-[min(560px,100vw)] sm:rounded-none sm:rounded-l-sheet"
      >
        <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4 sm:px-6">
          <div className="min-w-0">
            <h2 className="truncate font-serif text-[26px] leading-tight text-ink">{title}</h2>
            {subtitle ? <div className="mt-1 text-[14px] text-ink-muted">{subtitle}</div> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="-mr-1 flex h-11 w-11 flex-none items-center justify-center rounded-full
                       text-ink-muted transition-colors hover:bg-oat disabled:opacity-40"
          >
            <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <div className="grid-scroll flex-1 overflow-y-auto px-5 py-5 sm:px-6">{children}</div>

        {footer ? (
          <footer className="border-t border-line bg-oat-light px-5 py-4 sm:px-6">{footer}</footer>
        ) : null}
      </div>
    </div>
  );
}
