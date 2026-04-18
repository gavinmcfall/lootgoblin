export interface RateLimiterOpts {
  tokensPerSec: number;
  bucketSize: number;
}

export class RateLimiter {
  private tokens: number;
  private lastRefillMs = Date.now();
  private penaltyUntilMs = 0;

  constructor(private opts: RateLimiterOpts) {
    this.tokens = opts.bucketSize;
  }

  private refill(): void {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefillMs) / 1000;
    this.tokens = Math.min(this.opts.bucketSize, this.tokens + elapsedSec * this.opts.tokensPerSec);
    this.lastRefillMs = now;
  }

  delayMs(): number {
    this.refill();
    const penalty = Math.max(0, this.penaltyUntilMs - Date.now());
    if (this.tokens >= 1) return penalty;
    const waitSec = (1 - this.tokens) / this.opts.tokensPerSec;
    return Math.max(penalty, waitSec * 1000);
  }

  applyRetryAfter(ms: number): void {
    this.penaltyUntilMs = Date.now() + ms;
  }

  async take(): Promise<void> {
    const wait = this.delayMs();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.refill();
    this.tokens = Math.max(0, this.tokens - 1);
  }
}
