import { describe, it, expect } from 'vitest';
import { classifyError, nextRetryDelayMs, RetryPolicy } from '../../src/workers/retry';

const policy: RetryPolicy = { maxRetries: 3, backoffMs: [30_000, 120_000, 600_000] };

describe('retry', () => {
  it('classifies common errors', () => {
    expect(classifyError(Object.assign(new Error('a'), { retryable: false, name: 'CredentialInvalidError' })))
      .toEqual({ retryable: false, reason: 'CredentialInvalidError' });
    expect(classifyError(Object.assign(new Error('b'), { retryable: true, name: 'TransientError' })))
      .toMatchObject({ retryable: true });
  });

  it('returns backoff by attempt', () => {
    expect(nextRetryDelayMs(policy, 0)).toBe(30_000);
    expect(nextRetryDelayMs(policy, 1)).toBe(120_000);
    expect(nextRetryDelayMs(policy, 2)).toBe(600_000);
    expect(nextRetryDelayMs(policy, 3)).toBeNull();
  });
});
