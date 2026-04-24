/**
 * Rate-limit backoff helpers for ScavengerAdapters.
 *
 * Provides:
 *   - `nextRetry` — compute the next exponential-backoff retry decision
 *   - `sleep`     — cancellable Promise-based delay
 *
 * No DB, HTTP, or filesystem imports. Pure functions + standard timers.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result of a retry decision computation.
 * When `retry` is true the caller should wait `delayMs` before the next attempt.
 * When `retry` is false the caller should give up and emit a `failed` event.
 */
export type RetryDecision =
  | { retry: true; delayMs: number; attempt: number }
  | { retry: false; reason: 'max-attempts-exceeded' };

/**
 * Configuration for the retry/backoff strategy.
 * All fields are optional; defaults are documented inline.
 */
export type RetryConfig = {
  /** Base delay in ms. Default 1000. */
  baseMs?: number;
  /** Maximum delay ceiling in ms. Default 60_000. */
  maxMs?: number;
  /**
   * Maximum number of attempts before giving up.
   * Default 6 — covers attempt delays of 1s, 2s, 4s, 8s, 16s, 32s.
   */
  maxAttempts?: number;
  /**
   * Jitter factor in [0, 1]. Each computed delay is multiplied by a random
   * factor in [(1 - jitter), (1 + jitter)].
   * Default 0.3 — delays land in [0.7×delay, 1.3×delay].
   */
  jitter?: number;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_BASE_MS = 1_000;
const DEFAULT_MAX_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 6;
const DEFAULT_JITTER = 0.3;

// ---------------------------------------------------------------------------
// nextRetry
// ---------------------------------------------------------------------------

/**
 * Compute the next retry decision for a failed attempt.
 *
 * Attempt numbering is 1-based: pass 1 on the first failure, 2 on the second,
 * and so on. When `attempt >= maxAttempts`, returns `{retry: false}`.
 *
 * Backoff formula (before jitter):
 *   `delay = min(baseMs * 2^(attempt - 1), maxMs)`
 *
 * Jitter formula (applied after clamping):
 *   `delay = delay * (1 - jitter + Math.random() * jitter * 2)`
 *   which gives a uniform distribution in [delay*(1-j), delay*(1+j)].
 *
 * When `retryAfterMs` is provided (e.g. from a server `Retry-After` header),
 * it replaces the exponential formula as the base delay, before jitter + clamp.
 *
 * @param attempt      Current attempt number (1-based).
 * @param config       Optional retry configuration.
 * @param retryAfterMs Optional server-supplied retry-after in milliseconds.
 */
export function nextRetry(
  attempt: number,
  config?: RetryConfig,
  retryAfterMs?: number,
): RetryDecision {
  const baseMs = config?.baseMs ?? DEFAULT_BASE_MS;
  const maxMs = config?.maxMs ?? DEFAULT_MAX_MS;
  const maxAttempts = config?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const jitter = config?.jitter ?? DEFAULT_JITTER;

  if (attempt >= maxAttempts) {
    return { retry: false, reason: 'max-attempts-exceeded' };
  }

  // Compute raw delay before jitter.
  // When the server supplies a Retry-After value, use it verbatim as the base.
  const rawDelay =
    retryAfterMs !== undefined
      ? retryAfterMs
      : baseMs * Math.pow(2, attempt - 1);

  // Clamp to ceiling before jitter.
  const clamped = Math.min(rawDelay, maxMs);

  // Apply jitter: uniform in [(1 - jitter) * clamped, (1 + jitter) * clamped].
  const delayMs = clamped * (1 - jitter + Math.random() * jitter * 2);

  return { retry: true, delayMs, attempt };
}

// ---------------------------------------------------------------------------
// sleep
// ---------------------------------------------------------------------------

/**
 * Sleep for the given number of milliseconds.
 *
 * If `signal` is provided and already aborted at call time, rejects
 * immediately with an `AbortError` without setting any timer.
 *
 * If `signal` fires during the sleep, the promise rejects promptly with an
 * `AbortError` and the underlying timer is cleared.
 *
 * @param ms     Duration to sleep in milliseconds.
 * @param signal Optional AbortSignal to cancel the sleep.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // Reject immediately if the signal is already aborted.
    if (signal?.aborted) {
      reject(Object.assign(new Error('Sleep aborted'), { name: 'AbortError' }));
      return;
    }

    const timer = setTimeout(resolve, ms);

    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        reject(Object.assign(new Error('Sleep aborted'), { name: 'AbortError' }));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
