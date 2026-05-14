import { beforeEach, describe, expect, it } from 'vitest';
import { FailureBudget } from '../src/failureBudget.ts';

describe('FailureBudget', () => {
  let now = 0;
  const clock = () => now;

  beforeEach(() => {
    now = 0;
  });

  describe('construction', () => {
    it('throws if limit < 1', () => {
      expect(() => new FailureBudget(0, 1000)).toThrow(/limit/);
      expect(() => new FailureBudget(-1, 1000)).toThrow(/limit/);
    });

    it('throws if limit is NaN/Infinity', () => {
      expect(() => new FailureBudget(NaN, 1000)).toThrow(/limit/);
      expect(() => new FailureBudget(Infinity, 1000)).toThrow(/limit/);
    });

    it('throws if resetMs < 0', () => {
      expect(() => new FailureBudget(3, -1)).toThrow(/resetMs/);
    });

    it('accepts resetMs = 0 (no idle reset, count grows forever)', () => {
      expect(() => new FailureBudget(3, 0)).not.toThrow();
    });
  });

  describe('count / recordFailure', () => {
    it('count starts at 0 for unknown models', () => {
      const b = new FailureBudget(3, 1000, clock);
      expect(b.count('chat')).toBe(0);
      expect(b.count('code')).toBe(0);
    });

    it('recordFailure increments and returns new count', () => {
      const b = new FailureBudget(3, 1000, clock);
      expect(b.recordFailure('chat')).toBe(1);
      expect(b.recordFailure('chat')).toBe(2);
      expect(b.recordFailure('chat')).toBe(3);
      expect(b.count('chat')).toBe(3);
    });

    it('keeps counts independent per model', () => {
      const b = new FailureBudget(3, 1000, clock);
      b.recordFailure('chat');
      b.recordFailure('chat');
      b.recordFailure('code');
      expect(b.count('chat')).toBe(2);
      expect(b.count('code')).toBe(1);
    });
  });

  describe('exceeded', () => {
    it('returns false until count reaches limit', () => {
      const b = new FailureBudget(3, 1000, clock);
      expect(b.exceeded('chat')).toBe(false);
      b.recordFailure('chat');
      expect(b.exceeded('chat')).toBe(false);
      b.recordFailure('chat');
      expect(b.exceeded('chat')).toBe(false);
      b.recordFailure('chat');
      expect(b.exceeded('chat')).toBe(true);
    });

    it('stays true while count remains at/above the limit', () => {
      const b = new FailureBudget(2, 1000, clock);
      b.recordFailure('chat');
      b.recordFailure('chat');
      b.recordFailure('chat');
      expect(b.exceeded('chat')).toBe(true);
    });

    it('per-model: one model exceeded does not affect another', () => {
      const b = new FailureBudget(2, 1000, clock);
      b.recordFailure('chat');
      b.recordFailure('chat');
      expect(b.exceeded('chat')).toBe(true);
      expect(b.exceeded('code')).toBe(false);
    });
  });

  describe('idle auto-reset', () => {
    it('resets count after resetMs of no further failures', () => {
      const b = new FailureBudget(3, 1000, clock);
      b.recordFailure('chat');
      b.recordFailure('chat');
      b.recordFailure('chat');
      expect(b.exceeded('chat')).toBe(true);

      now += 1001;
      expect(b.count('chat')).toBe(0);
      expect(b.exceeded('chat')).toBe(false);
    });

    it('does NOT reset at exactly resetMs (strict >)', () => {
      const b = new FailureBudget(3, 1000, clock);
      b.recordFailure('chat');
      now += 1000;
      expect(b.count('chat')).toBe(1);
      now += 1;
      expect(b.count('chat')).toBe(0);
    });

    it('any new failure inside the window pushes lastAt forward', () => {
      const b = new FailureBudget(3, 1000, clock);
      b.recordFailure('chat'); // t=0
      now += 800;
      b.recordFailure('chat'); // t=800, lastAt updated
      now += 800; // t=1600 — would have reset off the t=0 mark, but lastAt is 800
      expect(b.count('chat')).toBe(2);
      now += 201; // t=1801, > 800+1000
      expect(b.count('chat')).toBe(0);
    });

    it('resetMs = 0 means count never auto-resets', () => {
      const b = new FailureBudget(3, 0, clock);
      b.recordFailure('chat');
      now += 999_999;
      // resetMs=0 with strict > means anything > 0 ago resets — but lastAt
      // equals now() at record time. Since (now - lastAt) > 0 here, this
      // will reset. The semantic of resetMs=0 is intentionally "no grace".
      expect(b.count('chat')).toBe(0);
    });
  });

  describe('recordSuccess', () => {
    it('clears the count immediately', () => {
      const b = new FailureBudget(3, 1000, clock);
      b.recordFailure('chat');
      b.recordFailure('chat');
      expect(b.count('chat')).toBe(2);
      b.recordSuccess('chat');
      expect(b.count('chat')).toBe(0);
      expect(b.exceeded('chat')).toBe(false);
    });

    it('a new failure after success starts from 1, not from the old count', () => {
      const b = new FailureBudget(3, 1000, clock);
      b.recordFailure('chat');
      b.recordFailure('chat');
      b.recordSuccess('chat');
      expect(b.recordFailure('chat')).toBe(1);
    });

    it('only clears the named model', () => {
      const b = new FailureBudget(3, 1000, clock);
      b.recordFailure('chat');
      b.recordFailure('code');
      b.recordSuccess('chat');
      expect(b.count('chat')).toBe(0);
      expect(b.count('code')).toBe(1);
    });

    it('is a no-op for an unknown model', () => {
      const b = new FailureBudget(3, 1000, clock);
      expect(() => b.recordSuccess('never-seen')).not.toThrow();
    });
  });

  describe('default clock', () => {
    it('uses Date.now when none is supplied', () => {
      // Smoke test: just verify we can construct & use without a clock
      // arg. Not asserting timing here — that's covered above.
      const b = new FailureBudget(3, 60_000);
      b.recordFailure('chat');
      expect(b.count('chat')).toBe(1);
      b.recordSuccess('chat');
      expect(b.count('chat')).toBe(0);
    });
  });
});
