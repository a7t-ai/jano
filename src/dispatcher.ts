import type { ModelName } from './types.ts';
import { env, modelNames } from './config.ts';
import { FailureBudget } from './failureBudget.ts';
import { _internal, getOldestEnqueuedAt, getQueueByModel, getQueueDepth } from './queue.ts';
import { detectLoaded, ensureLoaded } from './swap.ts';
import { telemetry } from './metrics.ts';
import { log } from './log.ts';

let currentModel: ModelName | null = null;
let running = false;

// After SWAP_FAILURE_LIMIT consecutive failures for a model, fail-fast any
// further queued tasks for that model with 503 instead of paying another
// SWAP_WAIT_TIMEOUT_MS per dispatch. Auto-resets after SWAP_FAILURE_RESET_MS
// of idle so a recovered backend gets retried without a jano restart.
// Reproduces the 2026-05-12 wedge fix.
const swapFailures = new FailureBudget(env.SWAP_FAILURE_LIMIT, env.SWAP_FAILURE_RESET_MS);

/** A request that never reached a backend (dead client, swap failure) still
 *  belongs in the usage history with its short-circuit status and no tokens. */
function recordShortCircuit(model: ModelName, status: number, enqueuedAt: number): void {
  telemetry.recordRequest({
    model,
    status,
    totalMs: Date.now() - enqueuedAt,
    ttfbMs: null,
    promptTokens: null,
    genTokens: null,
    genTokS: null,
    promptTokS: null,
  });
}

export function getStatus() {
  const oldest = getOldestEnqueuedAt();
  return {
    currentModel,
    queueDepth: getQueueDepth(),
    queueByModel: getQueueByModel(modelNames()),
    oldestWaitingMs: oldest === null ? 0 : Math.max(0, Date.now() - oldest),
    ...telemetry.snapshot(),
  };
}

async function loop(): Promise<void> {
  log.info('dispatcher started');
  while (running) {
    const task = _internal.takeFromQueue(currentModel);
    if (!task) {
      await _internal.awaitWakeUp();
      _internal.clearWakeUp();
      continue;
    }

    if (!task.isAlive()) {
      log.info('dropping disconnected task', { id: task.id, model: task.model });
      recordShortCircuit(task.model, 499, task.enqueuedAt);
      await task.fail(499, 'client disconnected before dispatch');
      continue;
    }

    if (task.model !== currentModel) {
      if (swapFailures.exceeded(task.model)) {
        const fails = swapFailures.count(task.model);
        log.warn('failing fast: backend marked bad', {
          id: task.id,
          model: task.model,
          fails,
        });
        telemetry.recordError(task.model, `fail-fast: ${fails} consecutive swap failures`);
        recordShortCircuit(task.model, 503, task.enqueuedAt);
        await task.fail(
          503,
          `backend "${task.model}" is unavailable (${fails} consecutive swap failures; auto-retry in ~${Math.round(env.SWAP_FAILURE_RESET_MS / 1000)}s)`
        );
        continue;
      }
      const swapStart = Date.now();
      try {
        await ensureLoaded(task.model);
        telemetry.recordSwap(currentModel, task.model, Date.now() - swapStart);
        currentModel = task.model;
        swapFailures.recordSuccess(task.model);
      } catch (err) {
        const newFails = swapFailures.recordFailure(task.model);
        log.error('swap failed', {
          id: task.id,
          model: task.model,
          fails: newFails,
          err: String(err),
        });
        telemetry.recordError(task.model, `swap failed: ${String(err)}`);
        recordShortCircuit(task.model, 503, task.enqueuedAt);
        await task.fail(503, `swap to "${task.model}" failed: ${String(err)}`);
        continue;
      }
    }

    try {
      telemetry.incInFlight();
      try {
        await task.run();
      } finally {
        telemetry.decInFlight();
      }
      swapFailures.recordSuccess(task.model);
    } catch (err) {
      log.error('task threw', { id: task.id, err: String(err) });
      telemetry.recordError(task.model, `task threw: ${String(err)}`);
    }
  }
  log.info('dispatcher stopped');
}

export async function start(): Promise<void> {
  if (running) return;
  running = true;
  telemetry.seedModels(modelNames());
  currentModel = await detectLoaded();
  if (currentModel !== null) telemetry.noteInitialModel(currentModel);
  log.info('dispatcher detected initial model', { currentModel });
  void loop();
}

export function stop(): void {
  running = false;
  _internal.pokeWakeUp();
}
