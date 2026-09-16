import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerModule, ThrottlerOptions } from '@nestjs/throttler';
import { PUBLIC_THROTTLERS, PublicThrottlerGuard } from './public-throttler.guard';

/** The guard's internals, which are protected and are exactly what is under test. */
type Inspectable = {
  throttlers: ThrottlerOptions[];
  reflector: Reflector;
  getTracker(req: unknown): Promise<string>;
};

/**
 * Built through Nest rather than with `new`, because the failure this is here to
 * catch was an injection one: a hand-rolled constructor that type-checked, unit
 * tested green against a mock, and handed the guard something that was not a
 * Reflector — which only surfaced on the first real public request.
 */
async function build(): Promise<Inspectable> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      // The root module's shape: one window, 300 a minute, for authenticated traffic.
      ThrottlerModule.forRoot({ throttlers: [{ name: 'default', ttl: 60_000, limit: 300 }] }),
    ],
    providers: [PublicThrottlerGuard],
  }).compile();

  // onModuleInit is where the windows are swapped.
  await moduleRef.init();
  return moduleRef.get(PublicThrottlerGuard) as unknown as Inspectable;
}

describe('PublicThrottlerGuard', () => {
  it('is handed a real Reflector by the container', async () => {
    const guard = await build();

    expect(guard.reflector).toBeInstanceOf(Reflector);
    expect(typeof guard.reflector.getAllAndOverride).toBe('function');
  });

  it('replaces the root module’s single window with the two public ones', async () => {
    // 10 a minute alone would let a script post nine an hour, all night; 60 an
    // hour alone would let it post sixty in one second. §12.4.
    const guard = await build();

    expect(guard.throttlers).toEqual([...PUBLIC_THROTTLERS]);
    expect(guard.throttlers.map((t) => t.name)).toEqual(['publicMinute', 'publicHour']);
  });

  it('keeps its own copy of the windows, so a @Throttle override cannot leak', async () => {
    const guard = await build();

    guard.throttlers[0]!.limit = 1;

    expect(PUBLIC_THROTTLERS[0]!.limit).toBe(10);
  });

  it('tracks an anonymous caller by IP, the only identity they have', async () => {
    const guard = await build();

    await expect(guard.getTracker({ ip: '203.0.113.9', socket: {} })).resolves.toBe(
      'ip:203.0.113.9',
    );
    await expect(
      guard.getTracker({ socket: { remoteAddress: '198.51.100.4' } }),
    ).resolves.toBe('ip:198.51.100.4');
  });
});
