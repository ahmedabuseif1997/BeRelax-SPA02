import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import * as bcrypt from 'bcrypt';
import { ErrorCode } from '@berelax/contracts';
import type { Env } from '../config/env';

const DEFAULT_COST = 12;

/**
 * A stand-in for the 10,000-entry list §6.1 calls for — the head of every
 * breach ranking, which is what an online guessing attack actually tries.
 * Swap in the full list at build time; the lookup stays O(1).
 *
 * The short entries cannot survive the 12-character minimum on their own, but
 * they are kept because the check also runs on operator-chosen passwords and
 * because the minimum is a policy that may move. The long entries are the ones
 * that matter today: they clear 12 characters and are still guessed first.
 */
const COMMON_PASSWORDS = new Set([
  '123456', 'password', '12345678', 'qwerty', '123456789', '12345', '1234',
  '111111', '1234567', 'dragon', '123123', 'baseball', 'abc123', 'football',
  'monkey', 'letmein', 'shadow', 'master', 'mustang', '666666', 'sunshine',
  'iloveyou', 'princess', 'admin', 'welcome', 'login', 'passw0rd', 'michael',
  'charlie', 'donald', 'qwerty123', '123qwe', 'whatever', 'freedom', 'batman',
  'ninja', 'azerty', 'access', 'flower', 'computer', 'jesus', 'ashley',
  'bailey', 'soccer', 'hockey', 'killer', 'hunter', 'ranger', 'starwars',
  // 12 characters or more: these pass the length rule and are guessed first.
  'password1234', 'passwordpassword', 'qwertyuiop123', '123456789012',
  '1234567890123', 'qwerty123456', 'welcome123456', 'letmein123456',
  'iloveyou1234', 'administrator', 'password@1234', 'thisisapassword',
  'trustno1234567', '1qaz2wsx3edc', 'q1w2e3r4t5y6', 'zaq12wsxcde3',
  'qazwsxedcrfv', 'asdfghjkl123', 'football12345', 'superman1234',
  'iloveyouforever', 'myspace1234567', 'abcd1234efgh', 'changeme1234',
]);

@Injectable()
export class PasswordService {
  private readonly cost: number;
  /** Cached because generating it costs a full bcrypt round. */
  private dummy?: Promise<string>;

  constructor(config: ConfigService<Env, true>) {
    // Number() because a ConfigModule registered without `validate: validateEnv`
    // hands back the raw string from process.env.
    this.cost = Number(config.get('BCRYPT_COST', { infer: true })) || DEFAULT_COST;
  }

  hash(plain: string): Promise<string> {
    return bcrypt.hash(plain, this.cost);
  }

  compare(plain: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plain, hash);
  }

  /**
   * Costs the same whether or not the account exists: without the decoy round a
   * stopwatch tells an attacker which email addresses are real. Spec §6.1.
   */
  async compareOrDummy(plain: string, hash: string | null | undefined): Promise<boolean> {
    if (hash) return this.compare(plain, hash);
    await bcrypt.compare(plain, await this.dummyHash());
    return false;
  }

  /** Re-hash on successful login if the stored cost has drifted below the configured one. */
  needsRehash(hash: string): boolean {
    const cost = Number(hash.split('$')[2]);
    return Number.isFinite(cost) && cost < this.cost;
  }

  /**
   * Length alone does not save a passphrase that is on every wordlist, so this
   * runs on every password the system accepts or generates.
   */
  assertNotCommon(password: string): void {
    if (COMMON_PASSWORDS.has(password.trim().toLowerCase())) {
      throw new UnprocessableEntityException({
        error: {
          code: ErrorCode.PASSWORD_TOO_COMMON,
          message: 'That password appears on public breach lists. Choose another.',
        },
      });
    }
  }

  /**
   * The one-time password handed to a new user. 16 base64url characters clear the
   * 12-character floor and carry 96 bits, so it is unguessable for the few minutes
   * it lives before `mustChangePassword` forces it out.
   */
  generateTemporary(): string {
    return randomBytes(12).toString('base64url');
  }

  /** A real hash at the configured cost — a hard-coded constant drifts from BCRYPT_COST. */
  private dummyHash(): Promise<string> {
    const pending = this.dummy ?? bcrypt.hash(randomBytes(24).toString('base64'), this.cost);
    this.dummy = pending;
    return pending;
  }
}
