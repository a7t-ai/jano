import type { FailFn, IsAliveFn, ModelName } from './types.ts';

export type Task = {
  id: string;
  model: ModelName;
  enqueuedAt: number;
  /** Resolves when the task is fully handled (response written or error reported). */
  run: () => Promise<void>;
  /** Short-circuit: send a non-2xx response and resolve. Used by the dispatcher
   *  for fail-fast paths (dead client, backend known bad). */
  fail: FailFn;
  /** False if the client has closed the socket since enqueueing. */
  isAlive: IsAliveFn;
};

const queue: Task[] = [];
let wakeUp: (() => void) | null = null;

export function getQueueDepth(): number {
  return queue.length;
}

export function getQueueByModel(modelNames: ModelName[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const name of modelNames) counts[name] = 0;
  for (const t of queue) {
    counts[t.model] = (counts[t.model] ?? 0) + 1;
  }
  return counts;
}

/** Enqueue time of the oldest waiting task, or null if the queue is empty.
 *  Powers the `oldestWaitingMs` "am I backed up?" signal on `/status`. */
export function getOldestEnqueuedAt(): number | null {
  let oldest: number | null = null;
  for (const t of queue) {
    if (oldest === null || t.enqueuedAt < oldest) oldest = t.enqueuedAt;
  }
  return oldest;
}

export function enqueue(task: Task): void {
  queue.push(task);
  wakeUp?.();
}

/**
 * Greedy batching: prefer the next queued task that matches the loaded model
 * over forcing a swap. This keeps a burst of same-model requests on the same
 * model rather than thrashing once per request. Generic over the task shape
 * so the same logic works for any number of models.
 *
 * Pure (mutates the passed array but reads no module state) so it can be
 * unit-tested without spinning up the dispatcher.
 */
export function takeNext<T extends { model: ModelName }>(
  q: T[],
  loaded: ModelName | null
): T | null {
  if (q.length === 0) return null;
  if (loaded !== null) {
    const idx = q.findIndex((t) => t.model === loaded);
    if (idx !== -1) return q.splice(idx, 1)[0]!;
  }
  return q.shift()!;
}

/**
 * Internal accessors used by the dispatcher. Splitting the queue from the
 * loop keeps this file env-free and trivial to unit test.
 */
export const _internal = {
  takeFromQueue(loaded: ModelName | null): Task | null {
    return takeNext(queue, loaded);
  },
  awaitWakeUp(): Promise<void> {
    return new Promise<void>((resolve) => {
      wakeUp = resolve;
    });
  },
  clearWakeUp(): void {
    wakeUp = null;
  },
  pokeWakeUp(): void {
    wakeUp?.();
  },
};
