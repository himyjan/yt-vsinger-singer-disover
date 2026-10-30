/**
 * An adaptive rate limiter.
 *
 * The free sources — InnerTube on YouTube, GQL on Twitch, the public Bilibili
 * API — have no published quota, but they do rate-limit, and the polite
 * thing is to back off rather than be blocked.
 *
 * The limiter keeps a minimum interval between requests and widens it
 * whenever a request comes back with a rate-limit response, then narrows it
 * again once the source has been quiet for a while. That is the same shape as
 * an exponential backoff, but it persists across requests instead of being
 * thrown away after each one.
 */

/** A response that means "slow down". */
export interface RateLimited {
  /** True when the response says the caller is being rate limited. */
  limited: boolean;
  /** How long to wait, in milliseconds, when the source says so. */
  retryAfterMs: number;
}

/** Detects a rate-limit response from a status code and a body. */
export function detectRateLimit(
  status: number,
  body: string,
): RateLimited {
  if (status === 429 || status === 412 || status === 503) {
    return { limited: true, retryAfterMs: 0 };
  }
  // Bilibili's risk control answers with a JSON code rather than a status.
  if (/"code":\s*-352/.test(body) || /risk|风控|too many requests/i.test(body)) {
    return { limited: true, retryAfterMs: 0 };
  }
  return { limited: false, retryAfterMs: 0 };
}

export interface RateLimiterOptions {
  /** The minimum gap between two requests, in milliseconds. */
  minIntervalMs: number;
  /** The largest gap the limiter will grow to. */
  maxIntervalMs?: number;
  /** How many consecutive rate-limited responses double the interval. */
  onLimit?: (message: string) => void;
  /** Called when the interval grows or shrinks. */
  onChange?: (intervalMs: number) => void;
}

export class RateLimiter {
  private interval: number;
  private readonly minInterval: number;
  private readonly maxInterval: number;
  private readonly onLimit?: (message: string) => void;
  private readonly onChange?: (intervalMs: number) => void;
  private lastRequest = 0;
  private consecutive = 0;
  /** The queue of waits, so concurrent callers are spaced one by one. */
  private tail: Promise<void> = Promise.resolve();

  constructor(options: RateLimiterOptions) {
    this.minInterval = options.minIntervalMs;
    this.interval = options.minIntervalMs;
    this.maxInterval = options.maxIntervalMs ?? 30_000;
    this.onLimit = options.onLimit;
    this.onChange = options.onChange;
  }

  /** The current minimum gap, in milliseconds. */
  get currentInterval(): number {
    return this.interval;
  }

  /** Waits until the next request may be made. */
  async wait(): Promise<void> {
    /**
     * Callers are **serialised**, not merely delayed.
     *
     * `lastRequest` is one number, so two callers that arrive together compute
     * the same `next`, sleep the same delay and then fire together — which is a
     * burst, exactly what the limiter exists to prevent. With one caller that
     * never showed; with a worker pool it would put N requests on the wire at
     * the same instant. Chaining the waits keeps the gap between *requests*
     * rather than the gap between *computations*.
     */
    const run = this.tail.then(async () => {
      const next = this.lastRequest + this.interval;
      const delay = next - Date.now();
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      this.lastRequest = Date.now();
    });
    /* The chain must survive a rejection, or every later wait hangs. */
    this.tail = run.catch(() => {});
    return run;
  }

  /**
   * True when the source has pushed back hard enough that it should be left
   * alone for a while.
   *
   * This is the circuit breaker. Without it, a source that is banning us
   * costs fifteen seconds *per channel* — a run of nine hundred channels
   * would take hours. With it, the run notices, stops calling that source
   * and moves on to the next one.
   */
  isTripped(): boolean {
    return this.interval >= this.maxInterval;
  }

  /**
   * Records that a request was rate limited.
   *
   * The interval doubles, up to the ceiling, and the caller should back off
   * before trying again.
   */
  penalise(): number {
    this.consecutive++;
    const next = Math.min(this.maxInterval, this.interval * 2);
    this.interval = next;
    this.onChange?.(this.interval);
    this.onLimit?.(
      `rate limited — the interval is now ${Math.round(this.interval)}ms`,
    );
    return this.interval;
  }

  /**
   * Records that a request succeeded.
   *
   * After a few successes the interval relaxes back towards the minimum, so
   * a single burst does not slow the whole run down for good.
   */
  reward(): void {
    this.consecutive = 0;
    if (this.interval > this.minInterval) {
      this.interval = Math.max(this.minInterval, Math.floor(this.interval / 2));
      this.onChange?.(this.interval);
    }
  }
}
