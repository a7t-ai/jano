import type { ModelName } from './types.ts';
import { env, modelNames } from './config.ts';
import { FailureBudget } from './failureBudget.ts';
import { _internal, getQueueByModel, getQueueDepth } from './queue.ts';
import { detectLoaded, ensureLoaded } from './swap.ts';
import { log } from './log.ts';

let currentModel: ModelName | null = null;
let running = false;

// After SWAP_FAILURE_LIMIT consecutive failures for a model, fail-fast any
// further queued tasks for that model with 503 instead of paying another
// SWAP_WAIT_TIMEOUT_MS per dispatch. Auto-resets after SWAP_FAILURE_RESET_MS
// of idle so a recovered backend gets retried without a jano restart.
// Reproduces the 2026-05-12 wedge fix.
const swapFailures = new FailureBudget(env.SWAP_FAILURE_LIMIT, env.SWAP_FAILURE_RESET_MS);

export function getStatus() {
  return {
    currentModel,
    queueDepth: getQueueDepth(),
    queueByModel: getQueueByModel(modelNames()),
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
        await task.fail(
          503,
          `backend "${task.model}" is unavailable (${fails} consecutive swap failures; auto-retry in ~${Math.round(env.SWAP_FAILURE_RESET_MS / 1000)}s)`
        );
        continue;
      }
      try {
        await ensureLoaded(task.model);
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
        await task.fail(503, `swap to "${task.model}" failed: ${String(err)}`);
        continue;
      }
    }

    try {
      await task.run();
      swapFailures.recordSuccess(task.model);
    } catch (err) {
      log.error('task threw', { id: task.id, err: String(err) });
    }
  }
  log.info('dispatcher stopped');
}

export async function start(): Promise<void> {
  if (running) return;
  running = true;
  currentModel = await detectLoaded();
  log.info('dispatcher detected initial model', { currentModel });
  void loop();
}

export function stop(): void {
  running = false;
  _internal.pokeWakeUp();
}
