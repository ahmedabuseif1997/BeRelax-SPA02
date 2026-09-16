'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { passwordSchema } from '@berelax/contracts';
import { useAuth } from '@/lib/auth-context';
import { Button, Spinner } from '@/components/ui/button';
import { ErrorNotice } from '@/components/ui/error-notice';

/**
 * A new account is created with `mustChangePassword`, and until it is cleared
 * the API answers 403 PASSWORD_CHANGE_REQUIRED on everything except this one
 * endpoint (spec §6.1). So this page is the whole application for that user.
 */
export default function ChangePasswordPage(): JSX.Element {
  const { status, changePassword, logout } = useAuth();
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (status === 'anonymous') router.replace('/login');
  }, [status, router]);

  if (status === 'loading' || status === 'anonymous') {
    return (
      <main className="flex min-h-screen items-center justify-center bg-cream">
        <Spinner />
      </main>
    );
  }

  const policy = passwordSchema.safeParse(newPassword);
  const mismatch = confirmation.length > 0 && confirmation !== newPassword;
  const ready = policy.success && !mismatch && currentPassword.length > 0;

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!ready || pending) return;
    setPending(true);
    setError(null);
    try {
      await changePassword(currentPassword, newPassword);
      router.replace('/');
    } catch (changeError) {
      setError(changeError);
    } finally {
      setPending(false);
    }
  };

  const voluntary = status === 'active';

  return (
    <main className="flex min-h-screen items-center justify-center bg-cream px-5 py-10">
      <div className="w-full max-w-[460px]">
        <div className="mb-7 text-center">
          <p className="eyebrow mb-3">BE RELAX</p>
          <h1 className="font-serif text-[30px] leading-tight text-ink">
            {voluntary ? 'Change your password' : 'Set a new password'}
          </h1>
          {voluntary ? null : (
            <p className="mt-3 text-[15px] leading-snug text-ink-muted">
              This account is still on the password it was created with. Set your own before
              opening the desk.
            </p>
          )}
        </div>

        <form
          onSubmit={(event) => void onSubmit(event)}
          className="rounded-2xl border border-line bg-white p-6 shadow-sm sm:p-8"
        >
          <div className="mb-5">
            <label className="field-label" htmlFor="current">
              Current password
            </label>
            <input
              id="current"
              className="field-input"
              type="password"
              autoComplete="current-password"
              required
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
            />
          </div>

          <div className="mb-5">
            <label className="field-label" htmlFor="next">
              New password
            </label>
            <input
              id="next"
              className="field-input"
              type="password"
              autoComplete="new-password"
              required
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
            <p
              className={`mt-2 text-[13px] ${
                newPassword.length === 0 || policy.success ? 'text-ink-muted' : 'text-alert'
              }`}
            >
              {newPassword.length === 0 || policy.success
                ? 'At least 12 characters. Length beats symbols — a phrase you will remember is a good password.'
                : (policy.error.issues[0]?.message ?? 'Use at least 12 characters.')}
            </p>
          </div>

          <div className="mb-6">
            <label className="field-label" htmlFor="confirm">
              Repeat new password
            </label>
            <input
              id="confirm"
              className="field-input"
              type="password"
              autoComplete="new-password"
              required
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
            {mismatch ? <p className="mt-2 text-[13px] text-alert">These do not match.</p> : null}
          </div>

          {error ? (
            <div className="mb-5">
              <ErrorNotice error={error} />
            </div>
          ) : null}

          <Button
            type="submit"
            variant="primary"
            size="lg"
            block
            disabled={!ready}
            pending={pending}
            pendingLabel="Saving…"
          >
            Save and continue
          </Button>

          <Button variant="quiet" size="md" block className="mt-2" onClick={() => void logout()}>
            Sign out instead
          </Button>
        </form>
      </div>
    </main>
  );
}
