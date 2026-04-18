import { describe, it, expect } from 'vitest';
import { RateLimiter } from '../../src/workers/rate-limit';

describe('rate limiter', () => {
  it('allows burst up to bucket size then throttles', async () => {
    const rl = new RateLimiter({ tokensPerSec: 2, bucketSize: 2 });
    const t0 = Date.now();
    await rl.take();
    await rl.take();
    await rl.take(); // should wait ~500ms
    expect(Date.now() - t0).toBeGreaterThanOrEqual(400);
  });

  it('honours server retry-after', () => {
    const rl = new RateLimiter({ tokensPerSec: 2, bucketSize: 2 });
    rl.applyRetryAfter(200);
    expect(rl.delayMs()).toBeGreaterThanOrEqual(180);
  });
});
