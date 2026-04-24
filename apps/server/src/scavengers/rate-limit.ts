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
 * ### Exponential branch (no `retryAfterMs`)
 *
 * Raw delay is clamped BEFORE jitter so jitter can still spread the delay
 * across peers (anti-thundering-herd). This is the standard exponential-backoff
 * convention. Consequence: the effective maximum is `maxMs * (1 + jitter)`.
 * With defaults (`maxMs=60_000`, `jitter=0.3`) delays can reach up to 78_000ms.
 *
 * Formula:
 *   `clamped    = min(baseMs * 2^(attempt - 1), maxMs)`
 *   `delayMs    = clamped * (1 - jitter + Math.random() * jitter * 2)`
 *
 * ### `retryAfterMs` branch (server-mandated backoff)
 *
 * When the server supplies a `Retry-After` value the server is telling us
 * *explicitly* how long to wait. We still apply jitter (to desynchronize peers
 * retrying at the same wall-clock tick) but clamp AFTER jitter to respect the
 * ceiling and never exceed `maxMs`.
 *
 * Formula:
 *   `jittered   = retryAfterMs * (1 - jitter + Math.random() * jitter * 2)`
 *   `delayMs    = min(jittered, maxMs)`
 *
 * @param attempt      Current attempt number (1-based, must be a positive integer).
 * @param config       Optional retry configuration.
 * @param retryAfterMs Optional server-supplied retry-after in milliseconds.
 *
 * @throws {RangeError} when `attempt` is not a positive integer.
 */
export function nextRetry(
  attempt: number,
  config?: RetryConfig,
  retryAfterMs?: number,
): RetryDecision {
  if (attempt < 1 || !Number.isInteger(attempt)) {
    throw new RangeError('attempt must be a positive integer (1-based)');
  }

  const baseMs = config?.baseMs ?? DEFAULT_BASE_MS;
  const maxMs = config?.maxMs ?? DEFAULT_MAX_MS;
  const maxAttempts = config?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const jitter = config?.jitter ?? DEFAULT_JITTER;

  if (attempt >= maxAttempts) {
    return { retry: false, reason: 'max-attempts-exceeded' };
  }

  let delayMs: number;
  if (retryAfterMs !== undefined) {
    // Server-mandated retry: apply jitter first, then clamp to maxMs so random
    // jitter never exceeds the ceiling the server asked us to respect.
    const jittered = retryAfterMs * (1 - jitter + Math.random() * jitter * 2);
    delayMs = Math.min(jittered, maxMs);
  } else {
    // Exponential branch: clamp first, then apply jitter. Jitter may overshoot
    // the clamp — effective ceiling is `maxMs * (1 + jitter)` — standard convention.
    const exponential = Math.min(baseMs * Math.pow(2, attempt - 1), maxMs);
    delayMs = exponential * (1 - jitter + Math.random() * jitter * 2);
  }

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

    // `{ once: true }` would only remove the abort listener when abort fires.
    // In the common (natural-resolution) path we explicitly remove the listener
    // so sleep-in-a-loop over a shared signal does not accumulate dead handlers.
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('Sleep aborted'), { name: 'AbortError' }));
    };

    timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}
