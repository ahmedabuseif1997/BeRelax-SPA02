/**
 * The post-login redirect. Found by security review: `startsWith('/')` accepts
 * "//evil.example/", and Next's router hands an absolute URL straight to
 * window.location.replace — so both the host and the scheme were caller
 * controlled. The attack is not token theft (the refresh cookie is SameSite
 * strict and the access token never leaves memory); it is phishing a
 * receptionist who has just signed in on the real origin.
 */
import { safeNext } from './safe-next';

describe('safeNext', () => {
  const ORIGIN = 'https://crm.berelax.ae';

  beforeAll(() => {
    Object.defineProperty(window, 'location', {
      value: new URL(ORIGIN) as unknown as Location,
      writable: true,
    });
  });

  it.each([
    ['/', '/'],
    ['/reports', '/reports'],
    ['/reports?tab=tips', '/reports?tab=tips'],
    ['/reservations#now', '/reservations#now'],
  ])('keeps the same-origin path %p', (input, expected) => {
    expect(safeNext(input)).toBe(expected);
  });

  it.each([
    ['//evil.example/', 'protocol-relative — the original bypass'],
    ['//evil.example', 'protocol-relative, no trailing slash'],
    ['https://evil.example/login', 'absolute, other host'],
    ['http://crm.berelax.ae/', 'same host, downgraded scheme'],
    ['javascript:alert(1)', 'script scheme'],
    ['data:text/html,<script>alert(1)</script>', 'data scheme'],
    ['\\\\evil.example/', 'backslashes, which some parsers fold to slashes'],
    ['/\\evil.example/', 'slash then backslash'],
    ['https://crm.berelax.ae.evil.example/', 'suffix that merely looks like us'],
  ])('refuses %p (%s)', (input) => {
    expect(safeNext(input)).toBe('/');
  });

  it.each([null, '', '   '])('falls back for %p', (input) => {
    expect(safeNext(input as string | null)).toBe('/');
  });
});
