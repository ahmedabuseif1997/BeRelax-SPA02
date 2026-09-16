import { HttpException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

// `import * as bcrypt` compiles to TypeScript's __importStar helper, which
// builds a namespace of non-configurable getters — jest.spyOn cannot patch
// those. Re-export the real module through a plain object and reach for it with
// requireMock, so the timing-oracle tests below have something spyable while
// every other test in this file still runs genuine bcrypt.
jest.mock('bcrypt', () => ({ ...jest.requireActual<object>('bcrypt') }));
const bcrypt = jest.requireMock<typeof import('bcrypt')>('bcrypt');
import { ErrorCode, passwordSchema } from '@berelax/contracts';
import type { ApiErrorBody } from '@berelax/contracts';
import type { Env } from '../config/env';
import { PasswordService } from './password.service';

/**
 * TypeScript's `import * as bcrypt` interop leaves the module's properties
 * non-configurable, so jest.spyOn cannot wrap them. Call-through mocks give the
 * same visibility without changing what bcrypt actually does.
 */
jest.mock('bcrypt', () => {
  const actual = jest.requireActual<typeof import('bcrypt')>('bcrypt');
  return { ...actual, compare: jest.fn(actual.compare), hash: jest.fn(actual.hash) };
});

const bcryptCompare = bcrypt.compare as unknown as jest.Mock;
const bcryptHash = bcrypt.hash as unknown as jest.Mock;

beforeEach(() => {
  bcryptCompare.mockClear();
  bcryptHash.mockClear();
});

/**
 * Cost 4 throughout: the production floor is BCRYPT_COST=12 (§6.1), which is a
 * quarter of a second per hash and would make this file take a minute.
 */
function service(cost = 4): PasswordService {
  return new PasswordService({ get: () => cost } as unknown as ConfigService<Env, true>);
}

function caught(run: () => unknown): { status: number; body: ApiErrorBody } {
  try {
    run();
  } catch (err) {
    const http = err as HttpException;
    return { status: http.getStatus(), body: http.getResponse() as ApiErrorBody };
  }
  throw new Error('expected the call to throw, but it returned');
}

describe('PasswordService', () => {
  describe('hashing', () => {
    it('hashes at the configured cost', async () => {
      const hash = await service(5).hash('a good long passphrase');
      expect(hash.startsWith('$2b$05$')).toBe(true);
    });

    it('salts, so the same password never produces the same hash twice', async () => {
      const passwords = service();
      const [a, b] = await Promise.all([passwords.hash('same input'), passwords.hash('same input')]);
      expect(a).not.toEqual(b);
    });

    it('accepts the password it hashed and nothing else', async () => {
      const passwords = service();
      const hash = await passwords.hash('correct horse battery staple');

      await expect(passwords.compare('correct horse battery staple', hash)).resolves.toBe(true);
      await expect(passwords.compare('correct horse battery stapl', hash)).resolves.toBe(false);
      await expect(passwords.compare('', hash)).resolves.toBe(false);
    });
  });

  describe('needsRehash', () => {
    it('is true only while the stored cost is below the configured one', async () => {
      const storedAtFour = await service(4).hash('a good long passphrase');

      expect(service(6).needsRehash(storedAtFour)).toBe(true);
      expect(service(4).needsRehash(storedAtFour)).toBe(false);
      expect(service(4).needsRehash(await service(6).hash('a good long passphrase'))).toBe(false);
    });

    it('does not ask for a rehash it cannot reason about', () => {
      expect(service().needsRehash('not-a-bcrypt-hash')).toBe(false);
    });
  });

  describe('compareOrDummy — the timing oracle guard (§6.1)', () => {
    it('still pays for a bcrypt round when there is no account to compare against', async () => {
      const passwords = service();

      await expect(passwords.compareOrDummy('whatever', null)).resolves.toBe(false);

      expect(bcryptCompare).toHaveBeenCalledTimes(1);
      // Against a real hash at the configured cost, not a short-circuit: the $2b$04$
      // prefix is what makes the work — and so the elapsed time — match the real path.
      expect(String(bcryptCompare.mock.calls[0]![1]).startsWith('$2b$04$')).toBe(true);
    });

    it('reuses the decoy hash rather than generating one per attempt', async () => {
      const passwords = service();
      await passwords.compareOrDummy('one', null);
      bcryptCompare.mockClear();
      bcryptHash.mockClear();

      await passwords.compareOrDummy('two', undefined);

      expect(bcryptCompare).toHaveBeenCalledTimes(1);
      expect(bcryptHash).not.toHaveBeenCalled();
    });

    it('defers to the real hash when the account does exist', async () => {
      const passwords = service();
      const hash = await passwords.hash('a good long passphrase');

      await expect(passwords.compareOrDummy('a good long passphrase', hash)).resolves.toBe(true);
      await expect(passwords.compareOrDummy('wrong', hash)).resolves.toBe(false);
    });
  });

  describe('assertNotCommon', () => {
    it('rejects a breached password with 422 PASSWORD_TOO_COMMON', () => {
      const { status, body } = caught(() => service().assertNotCommon('passwordpassword'));

      expect(status).toBe(422);
      expect(body.error.code).toBe(ErrorCode.PASSWORD_TOO_COMMON);
    });

    it('is not fooled by capitals or padding', () => {
      const passwords = service();
      expect(() => passwords.assertNotCommon('PassWord1234')).toThrow(HttpException);
      expect(() => passwords.assertNotCommon('  qwertyuiop123  ')).toThrow(HttpException);
    });

    it('lets an unremarkable long passphrase through', () => {
      expect(() => service().assertNotCommon('barefoot-lantern-tuesday')).not.toThrow();
    });
  });

  describe('generateTemporary', () => {
    it('produces something the password policy would accept', () => {
      const passwords = service();
      const temporary = passwords.generateTemporary();

      expect(passwordSchema.safeParse(temporary).success).toBe(true);
      expect(() => passwords.assertNotCommon(temporary)).not.toThrow();
    });

    it('never repeats', () => {
      const passwords = service();
      const issued = new Set(Array.from({ length: 50 }, () => passwords.generateTemporary()));
      expect(issued.size).toBe(50);
    });
  });
});
