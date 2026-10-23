/**
 * Exchange-failure accounting for the overlay's data plane.
 *
 * Extracted from sw.ts so the policy is testable without Service Worker
 * globals: a single failed exchange is not proof the plane is dead, but a run
 * of consecutive failures is.
 */

/**
 * How many consecutive failures are tolerated before declaring the data plane
 * dead. A single blip (ICE flap, one wedged SCTP stream) should not push every
 * request onto the fallback path.
 */
export const MAX_CONSECUTIVE_EXCHANGE_FAILURES = 3;

/**
 * Counts consecutive exchange failures and decides when to give up.
 *
 * Usage: call `ok()` after a successful exchange, `fail()` after a failed one;
 * `fail()` returns true once the threshold is reached (the caller then tears
 * the transport down). Any success resets the count.
 */
export class ExchangeHealth {
  private failures = 0;

  constructor(private readonly threshold: number = MAX_CONSECUTIVE_EXCHANGE_FAILURES) {
    if (threshold < 1) throw new Error("threshold must be >= 1");
  }

  /** A completed exchange proves the plane is alive. */
  ok(): void {
    this.failures = 0;
  }

  /**
   * Record a failure.
   * @returns true when the consecutive-failure threshold has been reached.
   */
  fail(): boolean {
    this.failures++;
    return this.failures >= this.threshold;
  }

  /** Current consecutive failure count (for diagnostics). */
  get consecutiveFailures(): number {
    return this.failures;
  }

  /** Forget past failures, e.g. after the transport was rebuilt. */
  reset(): void {
    this.failures = 0;
  }
}
