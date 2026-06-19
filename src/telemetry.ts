import type { ModelName } from './types.ts';

/**
 * In-process telemetry aggregator. This is Jano's wedge over a plain backend:
 * because Jano sees every request, every response, and invokes every swap, it
 * can serve queue depth, swap economics, rolling throughput, cumulative
 * counters, and a recent-request log that no single backend (Ollama,
 * llama-server, mlx-lm.server) can produce on its own.
 *
 * Everything lives in bounded ring buffers + counters; nothing is persisted.
 *
 * Pure-ish and clock-injectable (like {@link FailureBudget}) so the
 * aggregation logic is unit-testable without spinning up the server. The live
 * singleton is created in `metrics.ts`; the dispatcher and HTTP layer share it.
 */

/** One completed (or failed) request, as surfaced by `GET /usage`. */
export type RequestRecord = {
  /** Completion time, epoch ms. */
  ts: number;
  model: ModelName;
  status: number;
  /** Wall-clock from enqueue to fully handled. */
  totalMs: number;
  /** Time to first byte from dispatch, or null if never reached. */
  ttfbMs: number | null;
  promptTokens: number | null;
  genTokens: number | null;
  genTokS: number | null;
  promptTokS: number | null;
};

export type SwapRecord = {
  ts: number;
  from: ModelName | null;
  to: ModelName;
  durationMs: number;
};

export type ErrorRecord = {
  ts: number;
  model: ModelName | null;
  message: string;
};

export type Health = 'up' | 'down' | 'unknown';

const MS_15M = 15 * 60_000;
const MS_1H = 60 * 60_000;
const MS_1M = 60_000;

/** How many recent completions feed the rolling tok/s figures. */
const RECENT_SAMPLES = 30;
const SWAP_HISTORY_MAX = 500;
const ERROR_HISTORY_MAX = 200;

/** Cumulative histogram bucket upper bounds for swap duration, in ms. */
const SWAP_BUCKETS_MS = [1_000, 5_000, 15_000, 30_000, 60_000, 120_000, 300_000];

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function isOk(status: number): boolean {
  return status >= 200 && status < 300;
}

export class Telemetry {
  private readonly now: () => number;
  private readonly usageMax: number;
  private readonly startedAt: number;

  private inFlight = 0;
  private currentModelLoadedAt: number | null = null;
  private lastSwapDurationMs: number | null = null;

  private requests: RequestRecord[] = [];
  private swaps: SwapRecord[] = [];
  private errors: ErrorRecord[] = [];

  private requestsServedTotal = 0;
  private readonly requestsByModel = new Map<ModelName, number>();
  private tokensGeneratedTotal = 0;
  private readonly tokensByModel = new Map<ModelName, number>();
  private promptTokensTotal = 0;
  private errorsTotal = 0;
  private swapsTotal = 0;
  private readonly swapByTransition = new Map<string, { count: number; totalMs: number }>();

  private readonly health = new Map<ModelName, Health>();

  constructor(opts?: { now?: () => number; usageMax?: number }) {
    this.now = opts?.now ?? Date.now;
    this.usageMax = Math.max(1, opts?.usageMax ?? 500);
    this.startedAt = this.now();
  }

  // ---- mutation -----------------------------------------------------------

  /** Register known models so `backendHealth` lists them before any traffic. */
  seedModels(names: ModelName[]): void {
    for (const n of names) if (!this.health.has(n)) this.health.set(n, 'unknown');
  }

  incInFlight(): void {
    this.inFlight++;
  }

  decInFlight(): void {
    if (this.inFlight > 0) this.inFlight--;
  }

  /** Initial loaded model detected at startup — sets loadedAt, counts no swap. */
  noteInitialModel(model: ModelName): void {
    this.currentModelLoadedAt = this.now();
    this.health.set(model, 'up');
  }

  recordSwap(from: ModelName | null, to: ModelName, durationMs: number): void {
    const ts = this.now();
    this.swaps.push({ ts, from, to, durationMs });
    if (this.swaps.length > SWAP_HISTORY_MAX) this.swaps.shift();
    this.swapsTotal++;
    this.lastSwapDurationMs = durationMs;
    this.currentModelLoadedAt = ts;
    this.health.set(to, 'up');

    const key = `${from ?? '(none)'}→${to}`;
    const agg = this.swapByTransition.get(key) ?? { count: 0, totalMs: 0 };
    agg.count++;
    agg.totalMs += durationMs;
    this.swapByTransition.set(key, agg);
  }

  recordRequest(rec: Omit<RequestRecord, 'ts'>): void {
    const full: RequestRecord = { ts: this.now(), ...rec };
    this.requests.push(full);
    if (this.requests.length > this.usageMax) this.requests.shift();

    if (isOk(rec.status)) {
      this.requestsServedTotal++;
      this.requestsByModel.set(rec.model, (this.requestsByModel.get(rec.model) ?? 0) + 1);
      this.health.set(rec.model, 'up');
      if (rec.genTokens !== null) {
        this.tokensGeneratedTotal += rec.genTokens;
        this.tokensByModel.set(rec.model, (this.tokensByModel.get(rec.model) ?? 0) + rec.genTokens);
      }
      if (rec.promptTokens !== null) this.promptTokensTotal += rec.promptTokens;
    }
  }

  recordError(model: ModelName | null, message: string): void {
    this.errors.push({ ts: this.now(), model, message });
    if (this.errors.length > ERROR_HISTORY_MAX) this.errors.shift();
    this.errorsTotal++;
    if (model !== null) this.health.set(model, 'down');
  }

  // ---- aggregation --------------------------------------------------------

  private uptimeSeconds(): number {
    return Math.floor((this.now() - this.startedAt) / 1000);
  }

  private within<T extends { ts: number }>(xs: T[], ms: number): T[] {
    const cutoff = this.now() - ms;
    return xs.filter((x) => x.ts >= cutoff);
  }

  /** Mean of the last RECENT_SAMPLES non-null values of `pick`. */
  private recentMean(pick: (r: RequestRecord) => number | null): number | null {
    const vals: number[] = [];
    for (let i = this.requests.length - 1; i >= 0 && vals.length < RECENT_SAMPLES; i--) {
      const v = pick(this.requests[i]!);
      if (v !== null) vals.push(v);
    }
    const m = mean(vals);
    return m === null ? null : round1(m);
  }

  /** Recent gen tok/s per model, over the last RECENT_SAMPLES samples each. */
  private tokSByModel(): Record<string, number> {
    const buckets = new Map<ModelName, number[]>();
    for (let i = this.requests.length - 1; i >= 0; i--) {
      const r = this.requests[i]!;
      if (r.genTokS === null) continue;
      const arr = buckets.get(r.model) ?? [];
      if (arr.length < RECENT_SAMPLES) {
        arr.push(r.genTokS);
        buckets.set(r.model, arr);
      }
    }
    const out: Record<string, number> = {};
    for (const [model, arr] of buckets) {
      const m = mean(arr);
      if (m !== null) out[model] = round1(m);
    }
    return out;
  }

  private backendHealth(): Record<string, Health> {
    const out: Record<string, Health> = {};
    for (const [model, h] of this.health) out[model] = h;
    return out;
  }

  private lastError(): { ts: string; model: ModelName | null; message: string } | null {
    const e = this.errors[this.errors.length - 1];
    if (!e) return null;
    return { ts: new Date(e.ts).toISOString(), model: e.model, message: e.message };
  }

  /** The telemetry-owned slice of `GET /status`. Queue fields are merged in by
   *  the dispatcher, which owns the queue and current model. */
  snapshot() {
    return {
      currentModelLoadedAt:
        this.currentModelLoadedAt === null
          ? null
          : new Date(this.currentModelLoadedAt).toISOString(),
      inFlight: this.inFlight,
      lastSwapDurationMs: this.lastSwapDurationMs,
      swapsLast15m: this.within(this.swaps, MS_15M).length,
      swapsLastHour: this.within(this.swaps, MS_1H).length,
      recentGenTokS: this.recentMean((r) => r.genTokS),
      recentPromptTokS: this.recentMean((r) => r.promptTokS),
      tokSByModel: this.tokSByModel(),
      uptimeSeconds: this.uptimeSeconds(),
      requestsServedTotal: this.requestsServedTotal,
      requestsByModel: Object.fromEntries(this.requestsByModel),
      tokensGeneratedTotal: this.tokensGeneratedTotal,
      tokensByModel: Object.fromEntries(this.tokensByModel),
      requestsPerMinute: this.within(this.requests, MS_1M).length,
      errorsLast15m: this.within(this.errors, MS_15M).length,
      lastError: this.lastError(),
      backendHealth: this.backendHealth(),
    };
  }

  /** Recent request records, newest first, for `GET /usage`. */
  usageList(limit: number): Array<{
    ts: string;
    model: ModelName;
    status: number;
    total_ms: number;
    ttfb_ms: number | null;
    prompt_tokens: number | null;
    gen_tokens: number | null;
    gen_tok_s: number | null;
    prompt_tok_s: number | null;
  }> {
    const n = Math.max(0, Math.min(limit, this.requests.length));
    const out = [];
    for (let i = this.requests.length - 1; i >= this.requests.length - n; i--) {
      const r = this.requests[i]!;
      out.push({
        ts: new Date(r.ts).toISOString(),
        model: r.model,
        status: r.status,
        total_ms: r.totalMs,
        ttfb_ms: r.ttfbMs,
        prompt_tokens: r.promptTokens,
        gen_tokens: r.genTokens,
        gen_tok_s: r.genTokS === null ? null : round1(r.genTokS),
        prompt_tok_s: r.promptTokS === null ? null : round1(r.promptTokS),
      });
    }
    return out;
  }

  /**
   * Prometheus text exposition (v0.0.4). Queue gauges are passed in because
   * the queue is owned elsewhere; everything else is from this aggregator.
   */
  prometheus(queue: {
    queueByModel: Record<string, number>;
    currentModel: ModelName | null;
  }): string {
    const L: string[] = [];
    const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

    const help = (name: string, h: string, type: string): void => {
      L.push(`# HELP ${name} ${h}`);
      L.push(`# TYPE ${name} ${type}`);
    };

    help('jano_uptime_seconds', 'Seconds since jano started.', 'gauge');
    L.push(`jano_uptime_seconds ${this.uptimeSeconds()}`);

    help('jano_in_flight', 'Requests currently executing on a backend.', 'gauge');
    L.push(`jano_in_flight ${this.inFlight}`);

    help('jano_queue_depth', 'Requests waiting in the queue, per model.', 'gauge');
    for (const [model, n] of Object.entries(queue.queueByModel)) {
      L.push(`jano_queue_depth{model="${esc(model)}"} ${n}`);
    }

    help('jano_requests_served_total', 'Successfully served requests since start.', 'counter');
    for (const [model, n] of this.requestsByModel) {
      L.push(`jano_requests_served_total{model="${esc(model)}"} ${n}`);
    }

    help('jano_tokens_generated_total', 'Output tokens generated since start.', 'counter');
    for (const [model, n] of this.tokensByModel) {
      L.push(`jano_tokens_generated_total{model="${esc(model)}"} ${n}`);
    }

    help('jano_prompt_tokens_total', 'Prompt tokens processed since start.', 'counter');
    L.push(`jano_prompt_tokens_total ${this.promptTokensTotal}`);

    help('jano_recent_gen_tokens_per_second', 'Rolling generation tok/s, per model.', 'gauge');
    for (const [model, v] of Object.entries(this.tokSByModel())) {
      L.push(`jano_recent_gen_tokens_per_second{model="${esc(model)}"} ${v}`);
    }

    help('jano_errors_total', 'Errors recorded since start.', 'counter');
    L.push(`jano_errors_total ${this.errorsTotal}`);

    help('jano_swaps_total', 'Model swaps invoked since start, per transition.', 'counter');
    if (this.swapByTransition.size === 0) {
      L.push(`jano_swaps_total ${this.swapsTotal}`);
    } else {
      for (const [key, agg] of this.swapByTransition) {
        const [from, to] = key.split('→');
        L.push(`jano_swaps_total{from="${esc(from ?? '')}",to="${esc(to ?? '')}"} ${agg.count}`);
      }
    }

    // Per-transition cost table (swapCostByTransition): sum/count per
    // modelA→modelB so "which transitions hurt" is derivable as sum/count.
    help(
      'jano_swap_transition_duration_milliseconds',
      'Cumulative swap time per model transition.',
      'summary'
    );
    for (const [key, agg] of this.swapByTransition) {
      const [from, to] = key.split('→');
      const labels = `{from="${esc(from ?? '')}",to="${esc(to ?? '')}"}`;
      L.push(`jano_swap_transition_duration_milliseconds_sum${labels} ${agg.totalMs}`);
      L.push(`jano_swap_transition_duration_milliseconds_count${labels} ${agg.count}`);
    }

    help('jano_swap_duration_milliseconds', 'Distribution of model-swap durations.', 'histogram');
    let cumulative = 0;
    for (const le of SWAP_BUCKETS_MS) {
      cumulative = this.swaps.filter((s) => s.durationMs <= le).length;
      L.push(`jano_swap_duration_milliseconds_bucket{le="${le}"} ${cumulative}`);
    }
    L.push(`jano_swap_duration_milliseconds_bucket{le="+Inf"} ${this.swaps.length}`);
    const swapSum = this.swaps.reduce((a, s) => a + s.durationMs, 0);
    L.push(`jano_swap_duration_milliseconds_sum ${swapSum}`);
    L.push(`jano_swap_duration_milliseconds_count ${this.swaps.length}`);

    help('jano_backend_up', 'Backend health: 1 up, 0 down/unknown.', 'gauge');
    for (const [model, h] of this.health) {
      L.push(`jano_backend_up{model="${esc(model)}"} ${h === 'up' ? 1 : 0}`);
    }

    return L.join('\n') + '\n';
  }
}
