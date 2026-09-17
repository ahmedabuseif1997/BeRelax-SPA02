/**
 * A post-login destination is only safe if it resolves to a path on this
 * origin.
 *
 * `startsWith('/')` is not enough: "//evil.example/" passes it, and Next's
 * router hands an absolute URL to `window.location.replace`, so both the host
 * and the scheme end up caller-controlled. A receptionist who follows a link to
 * the real dashboard, signs in on the real origin, and is then bounced to a
 * clone saying "session expired" will type the password again.
 */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.trim()) return '/';
  try {
    const url = new URL(next, window.location.origin);
    if (url.origin !== window.location.origin) return '/';
    return `${url.pathname}${url.search}${url.hash}` || '/';
  } catch {
    return '/';
  }
}
