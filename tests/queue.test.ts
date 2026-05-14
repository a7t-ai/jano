import { describe, expect, it } from 'vitest';
import { takeNext } from '../src/queue.ts';

type T = { id: string; model: string };
const t = (id: string, model: string): T => ({ id, model });

describe('takeNext (greedy batching)', () => {
  it('returns null on an empty queue', () => {
    expect(takeNext<T>([], null)).toBeNull();
    expect(takeNext<T>([], 'chat')).toBeNull();
  });

  it('with no model loaded, takes the front of the queue (forces a swap)', () => {
    const q = [t('a', 'chat'), t('b', 'code')];
    expect(takeNext(q, null)?.id).toBe('a');
    expect(q.map((x) => x.id)).toEqual(['b']);
  });

  it('prefers a queued task that matches the loaded model', () => {
    const q = [t('a', 'chat'), t('b', 'code'), t('c', 'chat')];
    expect(takeNext(q, 'code')?.id).toBe('b');
    // The chats are untouched in their original order.
    expect(q.map((x) => x.id)).toEqual(['a', 'c']);
  });

  it('falls through to the front when no queued task matches loaded model', () => {
    const q = [t('a', 'chat'), t('b', 'chat')];
    expect(takeNext(q, 'code')?.id).toBe('a');
    expect(q.map((x) => x.id)).toEqual(['b']);
  });

  it('preserves queue order within a model', () => {
    const q = [t('first', 'chat'), t('second', 'chat'), t('third', 'chat')];
    expect(takeNext(q, 'chat')?.id).toBe('first');
    expect(takeNext(q, 'chat')?.id).toBe('second');
    expect(takeNext(q, 'chat')?.id).toBe('third');
    expect(takeNext(q, 'chat')).toBeNull();
  });

  describe('end-to-end: 6 interleaved requests across two models', () => {
    // Canonical scenario:
    //   1. chat  2. code  3. chat  4. chat  5. code  6. code
    // Strict FIFO from currentModel=chat would force 3 swaps; greedy
    // batching forces 1.
    const enqueue = () => [
      t('1', 'chat'),
      t('2', 'code'),
      t('3', 'chat'),
      t('4', 'chat'),
      t('5', 'code'),
      t('6', 'code'),
    ];

    function drain(q: T[], startModel: string | null) {
      const order: string[] = [];
      const swaps: string[] = [];
      let model = startModel;

      while (q.length > 0) {
        const next = takeNext(q, model);
        if (next === null) break;
        if (next.model !== model) {
          swaps.push(next.model);
          model = next.model;
        }
        order.push(next.id);
      }

      return { order, swaps };
    }

    it('with chat already loaded, drains all chats first then all codes (1 swap)', () => {
      const { order, swaps } = drain(enqueue(), 'chat');
      expect(order).toEqual(['1', '3', '4', '2', '5', '6']);
      expect(swaps).toEqual(['code']);
    });

    it('with code already loaded, drains all codes first then all chats (1 swap)', () => {
      const { order, swaps } = drain(enqueue(), 'code');
      expect(order).toEqual(['2', '5', '6', '1', '3', '4']);
      expect(swaps).toEqual(['chat']);
    });

    it('with no model loaded, takes front first then drains greedily', () => {
      const { order, swaps } = drain(enqueue(), null);
      expect(order).toEqual(['1', '3', '4', '2', '5', '6']);
      expect(swaps).toEqual(['chat', 'code']);
    });
  });

  describe('three-model case', () => {
    it('greedy still wins: drains current model first, then takes front-of-queue from the rest', () => {
      const q: T[] = [
        t('1', 'chat'),
        t('2', 'fast'),
        t('3', 'code'),
        t('4', 'fast'),
        t('5', 'chat'),
        t('6', 'fast'),
      ];
      const order: string[] = [];
      const swaps: string[] = [];
      let model: string | null = 'fast';

      while (q.length > 0) {
        const next: T | null = takeNext(q, model);
        if (next === null) break;
        if (next.model !== model) {
          swaps.push(next.model);
          model = next.model;
        }
        order.push(next.id);
      }

      // Starting on fast: drains all fasts first (2, 4, 6), then takes front
      // of remaining queue which is chat (1), drains both chats (1, 5), then
      // takes the lone code (3).
      expect(order).toEqual(['2', '4', '6', '1', '5', '3']);
      expect(swaps).toEqual(['chat', 'code']);
    });
  });

  it('strict-FIFO comparison: how many swaps a naive implementation would cost', () => {
    const q = [
      t('1', 'chat'),
      t('2', 'code'),
      t('3', 'chat'),
      t('4', 'chat'),
      t('5', 'code'),
      t('6', 'code'),
    ];
    let model = 'chat';
    let swaps = 0;
    for (const task of q) {
      if (task.model !== model) {
        swaps++;
        model = task.model;
      }
    }
    expect(swaps).toBe(3);
  });
});
