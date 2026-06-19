import { beforeEach, describe, expect, it } from 'vitest';
import { Telemetry, type RequestRecord } from '../src/telemetry.ts';

let now = 0;
const clock = () => now;

function req(over: Partial<Omit<RequestRecord, 'ts'>> = {}): Omit<RequestRecord, 'ts'> {
  return {
    model: 'chat',
    status: 200,
    totalMs: 100,
    ttfbMs: 10,
    promptTokens: 5,
    genTokens: 50,
    genTokS: 40,
    promptTokS: 200,
    ...over,
  };
}

describe('Telemetry', () => {
  beforeEach(() => {
    now = 1_000_000;
  });

  describe('counters', () => {
    it('counts only 2xx toward served-total and tokens', () => {
      const t = new Telemetry({ now: clock });
      t.recordRequest(req({ genTokens: 50 }));
      t.recordRequest(req({ genTokens: 30 }));
      t.recordRequest(req({ status: 503, genTokens: null }));
      const s = t.snapshot();
      expect(s.requestsServedTotal).toBe(2);
      expect(s.tokensGeneratedTotal).toBe(80);
      expect(s.requestsByModel).toEqual({ chat: 2 });
      expect(s.tokensByModel).toEqual({ chat: 80 });
    });

    it('non-2xx still lands in the usage history', () => {
      const t = new Telemetry({ now: clock });
      t.recordRequest(req({ status: 503, genTokens: null }));
      const list = t.usageList(10);
      expect(list).toHaveLength(1);
      expect(list[0]!.status).toBe(503);
    });
  });

  describe('rolling tok/s', () => {
    it('averages recent gen + prompt tok/s', () => {
      const t = new Telemetry({ now: clock });
      t.recordRequest(req({ genTokS: 40, promptTokS: 200 }));
      t.recordRequest(req({ genTokS: 60, promptTokS: 100 }));
      const s = t.snapshot();
      expect(s.recentGenTokS).toBe(50);
      expect(s.recentPromptTokS).toBe(150);
    });

    it('skips records with null tok/s', () => {
      const t = new Telemetry({ now: clock });
      t.recordRequest(req({ genTokS: null }));
      expect(t.snapshot().recentGenTokS).toBeNull();
    });

    it('reports tok/s per model', () => {
      const t = new Telemetry({ now: clock });
      t.recordRequest(req({ model: 'chat', genTokS: 50 }));
      t.recordRequest(req({ model: 'code', genTokS: 30 }));
      expect(t.snapshot().tokSByModel).toEqual({ chat: 50, code: 30 });
    });
  });

  describe('swaps', () => {
    it('records duration, loadedAt, and per-window counts', () => {
      const t = new Telemetry({ now: clock });
      t.recordSwap(null, 'chat', 21_840);
      const s = t.snapshot();
      expect(s.lastSwapDurationMs).toBe(21_840);
      expect(s.currentModelLoadedAt).toBe(new Date(now).toISOString());
      expect(s.swapsLast15m).toBe(1);
      expect(s.swapsLastHour).toBe(1);
    });

    it('ages swaps out of the 15m / 1h windows', () => {
      const t = new Telemetry({ now: clock });
      t.recordSwap('chat', 'code', 1000); // at t0
      now += 20 * 60_000; // +20 min
      t.recordSwap('code', 'chat', 1000); // recent
      const s = t.snapshot();
      expect(s.swapsLast15m).toBe(1); // only the +20m one is within 15m of now
      expect(s.swapsLastHour).toBe(2); // both within the hour
    });
  });

  describe('errors + health', () => {
    it('tracks recent errors, last error, and marks the backend down', () => {
      const t = new Telemetry({ now: clock });
      t.seedModels(['chat', 'code']);
      t.recordError('code', 'swap failed: boom');
      const s = t.snapshot();
      expect(s.errorsLast15m).toBe(1);
      expect(s.lastError?.model).toBe('code');
      expect(s.lastError?.message).toContain('boom');
      expect(s.backendHealth).toEqual({ chat: 'unknown', code: 'down' });
    });

    it('a later successful request flips health back up', () => {
      const t = new Telemetry({ now: clock });
      t.recordError('code', 'boom');
      t.recordRequest(req({ model: 'code', status: 200 }));
      expect(t.snapshot().backendHealth.code).toBe('up');
    });
  });

  describe('in-flight', () => {
    it('increments and decrements, never below zero', () => {
      const t = new Telemetry({ now: clock });
      t.incInFlight();
      t.incInFlight();
      expect(t.snapshot().inFlight).toBe(2);
      t.decInFlight();
      t.decInFlight();
      t.decInFlight();
      expect(t.snapshot().inFlight).toBe(0);
    });
  });

  describe('usage ring', () => {
    it('caps at usageMax, dropping oldest', () => {
      const t = new Telemetry({ now: clock, usageMax: 3 });
      for (let i = 0; i < 5; i++) t.recordRequest(req({ totalMs: i }));
      const list = t.usageList(100);
      expect(list).toHaveLength(3);
      // newest first: totalMs 4, 3, 2
      expect(list.map((r) => r.total_ms)).toEqual([4, 3, 2]);
    });

    it('emits snake_case fields with ISO timestamps', () => {
      const t = new Telemetry({ now: clock });
      t.recordRequest(req());
      const [rec] = t.usageList(1);
      expect(rec).toMatchObject({
        model: 'chat',
        status: 200,
        total_ms: 100,
        ttfb_ms: 10,
        prompt_tokens: 5,
        gen_tokens: 50,
        gen_tok_s: 40,
        prompt_tok_s: 200,
      });
      expect(rec!.ts).toBe(new Date(now).toISOString());
    });
  });

  describe('prometheus exposition', () => {
    it('emits counters, gauges, and a swap histogram', () => {
      const t = new Telemetry({ now: clock });
      t.seedModels(['chat', 'code']);
      t.recordSwap(null, 'chat', 12_000);
      t.recordRequest(req({ model: 'chat', genTokens: 50 }));
      t.recordError('code', 'boom');
      const text = t.prometheus({ queueByModel: { chat: 1, code: 0 }, currentModel: 'chat' });

      expect(text).toContain('# TYPE jano_uptime_seconds gauge');
      expect(text).toContain('jano_requests_served_total{model="chat"} 1');
      expect(text).toContain('jano_tokens_generated_total{model="chat"} 50');
      expect(text).toContain('jano_queue_depth{model="chat"} 1');
      expect(text).toContain('jano_errors_total 1');
      expect(text).toContain('jano_swaps_total{from="(none)",to="chat"} 1');
      // Per-transition cost table (swapCostByTransition).
      expect(text).toContain(
        'jano_swap_transition_duration_milliseconds_sum{from="(none)",to="chat"} 12000'
      );
      expect(text).toContain(
        'jano_swap_transition_duration_milliseconds_count{from="(none)",to="chat"} 1'
      );
      expect(text).toContain('jano_backend_up{model="chat"} 1');
      expect(text).toContain('jano_backend_up{model="code"} 0');
      // swap of 12s lands in the 15000ms bucket but not the 5000ms one
      expect(text).toContain('jano_swap_duration_milliseconds_bucket{le="5000"} 0');
      expect(text).toContain('jano_swap_duration_milliseconds_bucket{le="15000"} 1');
      expect(text).toContain('jano_swap_duration_milliseconds_count 1');
      expect(text).toMatch(/jano_swap_duration_milliseconds_sum 12000/);
    });

    it('escapes quotes/backslashes in label values', () => {
      const t = new Telemetry({ now: clock });
      t.recordRequest(req({ model: 'we"ird' }));
      const text = t.prometheus({ queueByModel: {}, currentModel: null });
      expect(text).toContain('jano_requests_served_total{model="we\\"ird"} 1');
    });
  });

  describe('uptime', () => {
    it('reports whole seconds since construction', () => {
      const t = new Telemetry({ now: clock });
      now += 84_211_000;
      expect(t.snapshot().uptimeSeconds).toBe(84_211);
    });
  });
});
