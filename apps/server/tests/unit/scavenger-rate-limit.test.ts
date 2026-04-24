import { describe, it, expect, vi, afterEach } from 'vitest';
import { nextRetry, sleep } from '../../src/scavengers/rate-limit';

// ---------------------------------------------------------------------------
// nextRetry — backoff decision
// ---------------------------------------------------------------------------

describe('nextRetry', () => {
  describe('default config', () => {
    it('attempt 1 returns retry:true with delay ≈ 1000ms ± 30% jitter', () => {
      const result = nextRetry(1);
      expect(result.retry).toBe(true);
      if (!result.retry) return; // type narrowing

      // Default: base 1000ms, jitter 0.3 → range [700, 1300]
      expect(result.delayMs).toBeGreaterThanOrEqual(700);
      expect(result.delayMs).toBeLessThanOrEqual(1300);
      expect(result.attempt).toBe(1);
    });

    it('attempt 2 returns delay ≈ 2000ms ± 30% jitter', () => {
      // Run multiple iterations to account for random jitter; all must be in range.
      for (let i = 0; i < 20; i++) {
        const result = nextRetry(2);
        expect(result.retry).toBe(true);
        if (!result.retry) continue;
        // base * 2^(2-1) = 1000 * 2 = 2000; range [1400, 2600]
        expect(result.delayMs).toBeGreaterThanOrEqual(1400);
        expect(result.delayMs).toBeLessThanOrEqual(2600);
      }
    });

    it('attempt 3 returns delay ≈ 4000ms ± 30% jitter', () => {
      for (let i = 0; i < 20; i++) {
        const result = nextRetry(3);
        expect(result.retry).toBe(true);
        if (!result.retry) continue;
        // base * 2^(3-1) = 1000 * 4 = 4000; range [2800, 5200]
        expect(result.delayMs).toBeGreaterThanOrEqual(2800);
        expect(result.delayMs).toBeLessThanOrEqual(5200);
      }
    });

    it('attempt 5 returns delay ≈ 16000ms ± 30% jitter', () => {
      for (let i = 0; i < 20; i++) {
        const result = nextRetry(5);
        expect(result.retry).toBe(true);
        if (!result.retry) continue;
        // base * 2^(5-1) = 1000 * 16 = 16000; range [11200, 20800]
        expect(result.delayMs).toBeGreaterThanOrEqual(11200);
        expect(result.delayMs).toBeLessThanOrEqual(20800);
      }
    });

    it('attempt 6 (= maxAttempts) returns {retry: false, reason: "max-attempts-exceeded"}', () => {
      const result = nextRetry(6);
      expect(result).toEqual({ retry: false, reason: 'max-attempts-exceeded' });
    });

    it('attempt 7 (> maxAttempts) also returns retry:false', () => {
      const result = nextRetry(7);
      expect(result.retry).toBe(false);
    });
  });

  describe('custom maxMs ceiling', () => {
    it('clamps delay to maxMs when base * 2^(attempt-1) exceeds it', () => {
      // attempt 1: raw = 1000, maxMs = 500 → clamped to 500 before jitter
      for (let i = 0; i < 20; i++) {
        const result = nextRetry(1, { maxMs: 500 });
        expect(result.retry).toBe(true);
        if (!result.retry) continue;
        // clamped 500 * (1-0.3 to 1+0.3) = [350, 650]
        expect(result.delayMs).toBeGreaterThanOrEqual(350);
        expect(result.delayMs).toBeLessThanOrEqual(650);
      }
    });

    it('does not clamp when delay is already under maxMs', () => {
      // attempt 1: raw = 1000, maxMs = 5000 → not clamped
      for (let i = 0; i < 20; i++) {
        const result = nextRetry(1, { maxMs: 5000 });
        expect(result.retry).toBe(true);
        if (!result.retry) continue;
        expect(result.delayMs).toBeGreaterThanOrEqual(700);
        expect(result.delayMs).toBeLessThanOrEqual(1300);
      }
    });
  });

  describe('custom maxAttempts', () => {
    it('returns retry:false when attempt == maxAttempts', () => {
      const result = nextRetry(3, { maxAttempts: 3 });
      expect(result.retry).toBe(false);
    });

    it('returns retry:true when attempt < maxAttempts', () => {
      const result = nextRetry(2, { maxAttempts: 3 });
      expect(result.retry).toBe(true);
    });
  });

  describe('server-supplied retryAfterMs', () => {
    it('uses retryAfterMs as the base delay (jitter applied, then clamped)', () => {
      for (let i = 0; i < 20; i++) {
        const result = nextRetry(1, {}, 5000);
        expect(result.retry).toBe(true);
        if (!result.retry) continue;
        // retryAfterMs=5000, maxMs=60000, jitter=0.3 → [3500, 6500]
        expect(result.delayMs).toBeGreaterThanOrEqual(3500);
        expect(result.delayMs).toBeLessThanOrEqual(6500);
      }
    });

    it('retryAfterMs is clamped to maxMs before jitter', () => {
      // retryAfterMs = 80000, maxMs = 60000 → clamped to 60000 → [42000, 78000]
      for (let i = 0; i < 20; i++) {
        const result = nextRetry(1, { maxMs: 60_000 }, 80_000);
        expect(result.retry).toBe(true);
        if (!result.retry) continue;
        expect(result.delayMs).toBeGreaterThanOrEqual(42_000);
        expect(result.delayMs).toBeLessThanOrEqual(78_000);
      }
    });

    it('retryAfterMs=0 still returns retry:true with near-zero delay', () => {
      for (let i = 0; i < 5; i++) {
        const result = nextRetry(1, {}, 0);
        expect(result.retry).toBe(true);
        if (!result.retry) continue;
        // 0 * anything = 0 (with jitter still 0)
        expect(result.delayMs).toBe(0);
      }
    });

    it('retryAfterMs is ignored when attempt >= maxAttempts', () => {
      const result = nextRetry(6, {}, 5000);
      expect(result.retry).toBe(false);
    });
  });

  describe('custom baseMs', () => {
    it('uses custom baseMs for exponential formula', () => {
      for (let i = 0; i < 20; i++) {
        const result = nextRetry(1, { baseMs: 500 });
        expect(result.retry).toBe(true);
        if (!result.retry) continue;
        // base=500, attempt=1: raw=500, jitter=0.3 → [350, 650]
        expect(result.delayMs).toBeGreaterThanOrEqual(350);
        expect(result.delayMs).toBeLessThanOrEqual(650);
      }
    });
  });

  describe('zero jitter', () => {
    it('returns exact delay with jitter=0', () => {
      const result = nextRetry(1, { jitter: 0 });
      expect(result.retry).toBe(true);
      if (!result.retry) return;
      // With jitter=0: delay = base * 1 = 1000 exactly
      expect(result.delayMs).toBe(1000);
    });

    it('attempt 4 with zero jitter returns exactly 8000ms', () => {
      const result = nextRetry(4, { jitter: 0 });
      expect(result.retry).toBe(true);
      if (!result.retry) return;
      // 1000 * 2^3 = 8000
      expect(result.delayMs).toBe(8000);
    });
  });

  describe('large attempt numbers (exponential overflow)', () => {
    it('clamps to maxMs for very large attempt numbers', () => {
      for (let i = 0; i < 10; i++) {
        const result = nextRetry(5, { maxAttempts: 100, jitter: 0 });
        expect(result.retry).toBe(true);
        if (!result.retry) continue;
        // attempt=5, base=1000: 1000*2^4 = 16000 < 60000; not clamped
        expect(result.delayMs).toBe(16000);
      }

      // attempt=10: 1000*2^9 = 512000 → clamped to 60000
      const big = nextRetry(10, { maxAttempts: 100, jitter: 0 });
      expect(big.retry).toBe(true);
      if (!big.retry) return;
      expect(big.delayMs).toBe(60_000);
    });
  });
});

// ---------------------------------------------------------------------------
// sleep — cancellable delay
// ---------------------------------------------------------------------------

describe('sleep', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves after approximately the given duration', async () => {
    vi.useFakeTimers();
    const promise = sleep(100);
    vi.advanceTimersByTime(100);
    await expect(promise).resolves.toBeUndefined();
  });

  it('does not resolve before the duration elapses', async () => {
    vi.useFakeTimers();
    let resolved = false;
    sleep(1000).then(() => {
      resolved = true;
    });
    vi.advanceTimersByTime(999);
    // Give microtasks a chance to flush
    await Promise.resolve();
    expect(resolved).toBe(false);
  });

  it('resolves after 0ms', async () => {
    vi.useFakeTimers();
    const promise = sleep(0);
    vi.advanceTimersByTime(0);
    await expect(promise).resolves.toBeUndefined();
  });

  it('rejects with AbortError when signal is pre-aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const promise = sleep(1000, controller.signal);
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects with AbortError when signal aborts mid-sleep', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();

    const promise = sleep(1000, controller.signal);
    // Abort before the timer fires
    vi.advanceTimersByTime(500);
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('does not reject when no signal is provided', async () => {
    vi.useFakeTimers();
    const promise = sleep(100);
    vi.advanceTimersByTime(100);
    await expect(promise).resolves.toBeUndefined();
  });

  it('resolves normally when signal is provided but never aborted', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const promise = sleep(100, controller.signal);
    vi.advanceTimersByTime(100);
    await expect(promise).resolves.toBeUndefined();
  });

  it('error name on pre-abort rejection is exactly "AbortError"', async () => {
    const controller = new AbortController();
    controller.abort();
    try {
      await sleep(500, controller.signal);
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as Error).name).toBe('AbortError');
    }
  });
});
