'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { loginSchema } from '@berelax/contracts';
import { useAuth } from '@/lib/auth-context';
import { Button } from '@/components/ui/button';
import { ErrorNotice } from '@/components/ui/error-notice';

export default function LoginPage(): JSX.Element {
  return (
    <Suspense fallback={<main className="min-h-screen bg-cream" />}>
      <LoginScreen />
    </Suspense>
  );
}

function LoginScreen(): JSX.Element {
  const { login, status, bootstrapOffline } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);

  const next = params.get('next');
  const destination = next && next.startsWith('/') ? next : '/';

  useEffect(() => {
    if (status === 'active') router.replace(destination);
    if (status === 'must-change-password') router.replace('/change-password');
  }, [status, router, destination]);

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (pending) return;

    // The same zod schema the API validates with, so a typo is caught at the
    // desk instead of costing a round trip on bad Wi-Fi.
    const parsed = loginSchema.safeParse({ email, password });
    if (!parsed.success) {
      setError(new Error('Enter the email address and password for this account.'));
      return;
    }

    setPending(true);
    setError(null);
    try {
      await login(parsed.data.email, parsed.data.password);
      router.replace(destination);
    } catch (loginError) {
      setError(loginError);
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-cream px-5 py-10">
      <div className="w-full max-w-[420px]">
        <div className="mb-8 text-center">
          <p className="eyebrow mb-3">Massage Center and Spa</p>
          <h1 className="font-serif text-[38px] leading-none tracking-[.06em] text-ink">
            BE RELAX
          </h1>
          <p className="mt-3 text-[15px] text-ink-muted">Reception sign-in</p>
        </div>

        <form
          onSubmit={(event) => void onSubmit(event)}
          className="rounded-2xl border border-line bg-white p-6 shadow-sm sm:p-8"
        >
          {bootstrapOffline ? (
            <div className="mb-5 rounded-xl border border-gold-light bg-gold-pale px-4 py-3 text-[14px] text-gold-deep">
              The booking system is not answering. Signing in will not work until it is back.
            </div>
          ) : null}

          <div className="mb-5">
            <label className="field-label" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              className="field-input"
              type="email"
              inputMode="email"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>

          <div className="mb-6">
            <label className="field-label" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              className="field-input"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>

          {error ? (
            <div className="mb-5">
              <ErrorNotice error={error} />
            </div>
          ) : null}

          <Button type="submit" variant="primary" size="lg" block pending={pending} pendingLabel="Signing in…">
            Sign in
          </Button>
        </form>

        <p className="mt-6 text-center text-[12.5px] leading-relaxed text-ink-muted">
          Five failed attempts locks the account for fifteen minutes.
          <br />
          Ask a manager if you are locked out.
        </p>
      </div>
    </main>
  );
}
