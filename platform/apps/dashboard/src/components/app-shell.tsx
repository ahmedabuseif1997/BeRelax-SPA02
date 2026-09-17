'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { useAuth } from '@/lib/auth-context';
import { can, roleLabel, type Capability } from '@/lib/roles';
import { Button, Spinner } from './ui/button';

/**
 * Route protection and the chrome around it.
 *
 * `mustChangePassword` is a hard redirect, not a banner: the API answers 403
 * PASSWORD_CHANGE_REQUIRED on every other endpoint until it is cleared, so
 * there is nothing else the screen could usefully show.
 */
export function AppShell({
  children,
  requires,
}: {
  children: ReactNode;
  /** The capability this route needs. Missing it redirects, never 403s. */
  requires?: Capability;
}): JSX.Element {
  const { status, user } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  const permitted = requires === undefined || can(user?.role, requires);

  useEffect(() => {
    if (status === 'loading') return;
    if (status === 'anonymous') {
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
      return;
    }
    if (status === 'must-change-password') {
      router.replace('/change-password');
      return;
    }
    if (!permitted) router.replace('/');
  }, [status, permitted, router, pathname]);

  if (status !== 'active' || !permitted) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-cream">
        <div className="flex items-center gap-3 text-ink-muted">
          <Spinner />
          <span className="text-[15px]">Opening the desk…</span>
        </div>
      </main>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-cream">
      <TopBar />
      <main className="flex min-h-0 flex-1 flex-col">{children}</main>
    </div>
  );
}

function TopBar(): JSX.Element {
  const { user, logout } = useAuth();
  const pathname = usePathname();

  // A RECEPTIONIST is never shown a link to revenue reports — not a disabled
  // one, not one that 403s. Reception takes money without seeing the totals,
  // because the person handling cash should not be the person auditing it. §6.4.
  const links: Array<{ href: string; label: string }> = [{ href: '/', label: 'Tonight' }];
  if (can(user?.role, 'reports.view')) links.push({ href: '/reports', label: 'Reports' });
  if (can(user?.role, 'reports.view')) links.push({ href: '/reconciliation', label: 'Reconciliation' });

  return (
    <header className="sticky top-0 z-30 flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-line bg-white/95 px-4 py-3 backdrop-blur sm:px-6">
      <Link href="/" className="flex items-baseline gap-2.5">
        <span className="font-serif text-[23px] font-medium tracking-[.06em] text-ink">
          BE RELAX
        </span>
        <span className="hidden text-[8.5px] uppercase tracking-eyebrow text-ink-muted sm:block">
          Reception
        </span>
      </Link>

      <nav className="flex items-center gap-1">
        {links.map((link) => {
          const active = pathname === link.href;
          return (
            <Link
              key={link.href}
              href={link.href}
              className={[
                'flex min-h-[44px] items-center rounded-full px-4 text-[13px] uppercase tracking-label transition-colors',
                active ? 'bg-teal-700 text-white' : 'text-ink-muted hover:bg-oat hover:text-ink',
              ].join(' ')}
            >
              {link.label}
            </Link>
          );
        })}
      </nav>

      <div className="ml-auto flex items-center gap-3">
        <div className="hidden text-right leading-tight sm:block">
          <p className="text-[14px] text-ink">{user?.fullName}</p>
          <p className="text-[11px] uppercase tracking-label text-ink-muted">
            {user ? roleLabel(user.role) : ''}
          </p>
        </div>
        <Button variant="quiet" size="md" onClick={() => void logout()}>
          Sign out
        </Button>
      </div>
    </header>
  );
}
