import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import type { ModelDef, ModelName } from './types.ts';

loadEnv({ path: '.env', quiet: true });

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

function optInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be an integer, got ${v}`);
  return n;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new Error(`${name} is required (set in .env or process env)`);
  }
  return v;
}

function loadModels(path: string): ModelDef[] {
  const abs = resolve(path);
  let raw: string;
  try {
    raw = readFileSync(abs, 'utf8');
  } catch (err) {
    throw new Error(`MODELS_FILE not readable at ${abs}: ${String(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`MODELS_FILE is not valid JSON at ${abs}: ${String(err)}`);
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as { models?: unknown }).models)
  ) {
    throw new Error(`MODELS_FILE must be an object with a "models" array (got ${abs})`);
  }

  const arr = (parsed as { models: unknown[] }).models;
  const out: ModelDef[] = [];
  const seen = new Set<string>();

  for (const [i, entry] of arr.entries()) {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`models[${i}] must be an object`);
    }
    const m = entry as Record<string, unknown>;
    const name = m.name;
    const url = m.url;
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(`models[${i}].name must be a non-empty string`);
    }
    if (typeof url !== 'string' || url.length === 0) {
      throw new Error(`models[${i}].url must be a non-empty string`);
    }
    if (seen.has(name)) {
      throw new Error(`duplicate model name "${name}"`);
    }
    seen.add(name);
    let aliases: string[] | undefined;
    if (m.aliases !== undefined) {
      if (
        !Array.isArray(m.aliases) ||
        m.aliases.some((a) => typeof a !== 'string' || a.length === 0)
      ) {
        throw new Error(`models[${i}].aliases must be an array of non-empty strings`);
      }
      aliases = m.aliases as string[];
    }
    let passthrough: boolean | undefined;
    if (m.passthrough !== undefined) {
      if (typeof m.passthrough !== 'boolean') {
        throw new Error(`models[${i}].passthrough must be a boolean`);
      }
      passthrough = m.passthrough;
    }
    let endpoints: string[] | undefined;
    if (m.endpoints !== undefined) {
      if (
        !Array.isArray(m.endpoints) ||
        m.endpoints.some((e) => typeof e !== 'string' || e.length === 0)
      ) {
        throw new Error(`models[${i}].endpoints must be an array of non-empty strings`);
      }
      endpoints = m.endpoints as string[];
    }
    out.push({ name, url, aliases, passthrough, endpoints });
  }

  if (out.length === 0) {
    throw new Error('models[] must contain at least one entry');
  }
  return out;
}

export const env = {
  JANO_HOST: optional('JANO_HOST', '127.0.0.1'),
  JANO_PORT: optInt('JANO_PORT', 8082),

  /**
   * Path to a script/binary that, given a model name as its single argument,
   * makes that model the loaded one. Should exit 0 once the swap has been
   * initiated; jano will then poll the matching backend's /health until it
   * responds 200 (timeout: SWAP_WAIT_TIMEOUT_MS).
   *
   * The script must be idempotent.
   */
  SWAP_COMMAND: required('SWAP_COMMAND'),

  /** Path to the JSON file defining the available backends. */
  MODELS_FILE: optional('MODELS_FILE', './models.json'),

  SWAP_WAIT_TIMEOUT_MS: optInt('SWAP_WAIT_TIMEOUT_MS', 180_000),
  HEALTH_POLL_INTERVAL_MS: optInt('HEALTH_POLL_INTERVAL_MS', 1_000),

  REQUEST_TIMEOUT_MS: optInt('REQUEST_TIMEOUT_MS', 10 * 60_000),

  /** After this many consecutive swap failures for a model, fail-fast
   *  further requests for that model with 503 instead of retrying. */
  SWAP_FAILURE_LIMIT: optInt('SWAP_FAILURE_LIMIT', 3),
  /** Reset a model's swap-failure count after it has been quiet this long;
   *  lets the dispatcher retry once a broken backend may have recovered. */
  SWAP_FAILURE_RESET_MS: optInt('SWAP_FAILURE_RESET_MS', 5 * 60_000),
};

export const models: ModelDef[] = loadModels(env.MODELS_FILE);
const modelByName = new Map(models.map((m) => [m.name, m]));

export function backendUrl(name: ModelName): string {
  const m = modelByName.get(name);
  if (!m) throw new Error(`unknown model "${name}"`);
  return m.url;
}

export function modelNames(): ModelName[] {
  return models.map((m) => m.name);
}

/** Models the dispatcher actually queues + swaps. Passthrough models bypass
 *  the queue, so the dispatcher should not consider them when computing
 *  whether to invoke the swap script. */
export const swapEligibleModels = models.filter((m) => !m.passthrough);

