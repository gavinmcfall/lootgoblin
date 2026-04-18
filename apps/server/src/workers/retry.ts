export interface RetryPolicy { maxRetries: number; backoffMs: number[]; }

export const defaultRetryPolicy: RetryPolicy = {
  maxRetries: 3,
  backoffMs: [30_000, 120_000, 600_000],
};

export function classifyError(err: unknown): { retryable: boolean; reason: string } {
  if (err instanceof Error) {
    const retryable = (err as Error & { retryable?: boolean }).retryable;
    return { retryable: retryable === true, reason: err.name };
  }
  return { retryable: false, reason: 'Unknown' };
}

export function nextRetryDelayMs(policy: RetryPolicy, attemptsSoFar: number): number | null {
  if (attemptsSoFar >= policy.maxRetries) return null;
  const idx = Math.min(attemptsSoFar, policy.backoffMs.length - 1);
  return policy.backoffMs[idx];
}
