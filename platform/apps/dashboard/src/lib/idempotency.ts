'use client';

import { useCallback, useRef, useState } from 'react';

/**
 * One Idempotency-Key per *attempt*, reused on every retry of that attempt.
 *
 * Reception is on patchy Wi-Fi at 01:00. A request times out, the receptionist
 * taps Confirm again — and the API replays the stored response instead of
 * charging the guest twice, but only if the retry carries the same key AND the
 * same body (a different body on a used key is a 409 IDEMPOTENCY_KEY_REUSED).
 *
 * So the key is bound to the body: change the amount and you are making a new
 * attempt, which gets a new key. Spec §7.6.
 */

/**
 * `crypto.randomUUID` needs a secure context. An iPad opening the dev server
 * over a LAN IP is not one, so fall back to a v4 built from getRandomValues
 * rather than dropping to Math.random for something that guards money.
 */
export function newIdempotencyKey(): string {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === 'function') return webCrypto.randomUUID();

  const bytes = new Uint8Array(16);
  webCrypto.getRandomValues(bytes);
  // Version 4, variant 10xx — the two bits that make it a valid UUID.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Returns the key for the current attempt. The signature is the request body:
 * while it is unchanged, every retry gets the same key.
 */
export function useIdempotencyKey(signature: string): string {
  const attempt = useRef<{ signature: string; key: string } | null>(null);
  if (attempt.current === null || attempt.current.signature !== signature) {
    attempt.current = { signature, key: newIdempotencyKey() };
  }
  return attempt.current.key;
}

export interface MoneyAction<T> {
  run: () => Promise<T | null>;
  pending: boolean;
  /** The key that went out with the last attempt, for the retry copy. */
  key: string;
}

/**
 * Wraps a money write so the sheet does not have to think about keys, double
 * taps or in-flight state. `body` is the exact payload; its JSON is the
 * attempt's signature.
 */
export function useMoneyAction<TBody, TResult>(
  body: TBody,
  send: (body: TBody, idempotencyKey: string) => Promise<TResult>,
  onError: (error: unknown) => void,
): MoneyAction<TResult> {
  const signature = JSON.stringify(body);
  const key = useIdempotencyKey(signature);
  const [pending, setPending] = useState(false);
  // A second tap while the first is still in the air must do nothing at all —
  // React state is too slow to stop a double tap on its own.
  const inFlight = useRef(false);

  const run = useCallback(async (): Promise<TResult | null> => {
    if (inFlight.current) return null;
    inFlight.current = true;
    setPending(true);
    try {
      return await send(body, key);
    } catch (error) {
      onError(error);
      return null;
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }, [body, key, send, onError]);

  return { run, pending, key };
}
