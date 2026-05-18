import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { backendUrl, env, swapEligibleModels } from './config.ts';
import type { ModelName } from './types.ts';
import { log } from './log.ts';

const execFile = promisify(execFileCb);

const swapEligibleNames = (): ModelName[] => swapEligibleModels.map((m) => m.name);

/**
 * Probe `<SWAP_COMMAND> status` (if implemented) to learn which model is
 * loaded at startup. Falls back to hitting each backend's /health and
 * accepting whichever responds first. Returns null if nothing answers.
 *
 * Only considers swap-eligible models — passthrough backends are always
 * resident and never become "the loaded model" from the dispatcher's POV.
 */
export async function detectLoaded(): Promise<ModelName | null> {
  try {
    const { stdout } = await execFile(env.SWAP_COMMAND, ['status']);
    for (const name of swapEligibleNames()) {
      const re = new RegExp(`(^|\\b)${escapeRegex(name)}:\\s*loaded\\b`, 'i');
      if (re.test(stdout)) return name;
    }
  } catch {
    // Script doesn't implement `status`. Fall through to direct health probes.
  }

  for (const name of swapEligibleNames()) {
    try {
      const res = await fetch(`${backendUrl(name)}/health`, {
        signal: AbortSignal.timeout(1_500),
      });
      if (res.ok) return name;
    } catch {
      // Backend not reachable; try the next.
    }
  }

  return null;
}

/**
 * Idempotent: invoking SWAP_COMMAND for the active model should be a no-op
 * (this is a contract on the script). Polls the chosen backend's /health
 * until it returns 200 or the configured timeout elapses.
 */
export async function ensureLoaded(model: ModelName): Promise<void> {
  const t0 = Date.now();
  log.info('swap requested', { model });
  await execFile(env.SWAP_COMMAND, [model]);

  const url = `${backendUrl(model)}/health`;
  const deadline = Date.now() + env.SWAP_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) {
        log.info('swap ready', { model, ms: Date.now() - t0 });
        return;
      }
    } catch {
      // Backend still loading; keep polling.
    }
    await sleep(env.HEALTH_POLL_INTERVAL_MS);
  }
  throw new Error(`timed out waiting for ${model} backend at ${url}`);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
