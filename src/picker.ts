import type { ModelDef, ModelName } from './types.ts';

/**
 * Map an OpenAI-style `model` field to one of the configured models.
 *
 * Matches case-insensitively against:
 *   - the model's `name`
 *   - any string in the model's `aliases[]`
 *
 * Pure: no env reads, no I/O. Pass the model list in via {@link models} so
 * this stays trivial to unit test.
 */
export function pickModel(raw: unknown, models: ModelDef[]): ModelName | null {
  if (typeof raw !== 'string') return null;
  if (raw.length === 0) return null;
  const m = raw.toLowerCase();
  for (const def of models) {
    if (def.name.toLowerCase() === m) return def.name;
    if (def.aliases?.some((a) => a.toLowerCase() === m)) return def.name;
  }
  return null;
}
