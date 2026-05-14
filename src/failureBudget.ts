import type { ModelName } from './types.ts';

/**
 * Per-model "consecutive swap failures" counter with idle-based auto-reset.
 *
 * Used by the dispatcher so that a permanently-broken backend (e.g. a
 * llama-server with a bad CLI flag KeepAlive-restart-looping) does not
 * cause every queued request to pay SWAP_WAIT_TIMEOUT_MS before failing.
 * Once the count for a model reaches `limit`, the dispatcher fails further
 * requests for that model fast with 503. After `resetMs` of no further
 * failures recorded, the count is forgotten so a recovered backend gets
 * tried again automatically without a jano restart.
 *
 * Pure (no module state, takes its clock) so it's trivially testable.
 */
export class FailureBudget {
  private failures = new Map<ModelName, { count: number; lastAt: number }>();
  private readonly limit: number;
  private readonly resetMs: number;
  private readonly now: () => number;

  constructor(limit: number, resetMs: number, now: () => number = Date.now) {
    if (!Number.isFinite(limit) || limit < 1) {
      throw new Error(`FailureBudget.limit must be >= 1, got ${limit}`);
    }
    if (!Number.isFinite(resetMs) || resetMs < 0) {
      throw new Error(`FailureBudget.resetMs must be >= 0, got ${resetMs}`);
    }
    this.limit = limit;
    this.resetMs = resetMs;
    this.now = now;
  }

  /** Current failure count for the model, after applying the idle reset. */
  count(model: ModelName): number {
    const f = this.failures.get(model);
    if (!f) return 0;
    if (this.now() - f.lastAt > this.resetMs) {
      this.failures.delete(model);
      return 0;
    }
    return f.count;
  }

  /** True iff `count(model) >= limit` — i.e. dispatcher should fail-fast. */
  exceeded(model: ModelName): boolean {
    return this.count(model) >= this.limit;
  }

  /** Increment and return the new count. Updates lastAt to "now". */
  recordFailure(model: ModelName): number {
    const prev = this.failures.get(model)?.count ?? 0;
    const next = prev + 1;
    this.failures.set(model, { count: next, lastAt: this.now() });
    return next;
  }

  /** Forget the model's failure history (called after a successful swap or run). */
  recordSuccess(model: ModelName): void {
    this.failures.delete(model);
  }
}
