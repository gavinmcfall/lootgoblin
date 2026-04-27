import { describe, it, expect } from 'vitest';
import { RateLimiter } from '../../src/workers/rate-limit';

// Timing tolerances widened intentionally. The point of these tests is to
// verify the rate-limiter does meaningfully throttle / honour retry-after,
// not to assert sub-millisecond timing. setTimeout precision and test-runner
// load can shave 10-50ms off any wait, so the lower bounds are generous.
// Upper bounds are deliberately loose (or absent) to survive loaded runners.
// (V4B-CF-2)

describe('rate limiter', () => {
  it('allows burst up to bucket size then throttles', async () => {
    // Use a longer expected wait (~1000ms at tokensPerSec=1) so timer drift
    // is small relative to the assertion window.
    const rl = new RateLimiter({ tokensPerSec: 1, bucketSize: 2 });
    const t0 = Date.now();
    await rl.take();
    await rl.take();
    await rl.take(); // should wait ~1000ms (1 token / 1 token-per-sec)
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(700); // generous lower bound
    expect(elapsed).toBeLessThan(5000); // sanity upper — no infinite loop / silly drift
  });

  it('honours server retry-after', () => {
    const rl = new RateLimiter({ tokensPerSec: 2, bucketSize: 2 });
    rl.applyRetryAfter(500);
    // Allow ~50ms slack between applyRetryAfter and delayMs() reading the clock.
    expect(rl.delayMs()).toBeGreaterThanOrEqual(400);
    expect(rl.delayMs()).toBeLessThanOrEqual(600);
  });
});
