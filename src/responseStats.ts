/**
 * Pure helpers for pulling token counts and timings out of a backend's
 * response, without disturbing the bytes we forward to the client.
 *
 * Jano forwards request bodies untouched and streams responses through, so
 * the only place token-level telemetry can come from is the response itself.
 * Two shapes show up in practice:
 *
 *   - OpenAI-style JSON (`usage: { prompt_tokens, completion_tokens }`),
 *     present in non-streaming completions and — only when the caller asks
 *     for `stream_options.include_usage` — in the final SSE chunk.
 *   - llama.cpp's `timings` block (`predicted_per_second`, `predicted_n`,
 *     `prompt_per_second`, `prompt_n`), which carries tok/s directly so we
 *     don't have to derive it.
 *
 * When neither is present (the common streaming case) we return null and the
 * caller falls back to deriving tok/s from wall-clock timing, or records the
 * request with null token counts. Telemetry degrades gracefully either way.
 */

export type ResponseStats = {
  promptTokens: number | null;
  genTokens: number | null;
  /** Generation tok/s as reported by the backend (llama.cpp `timings`). */
  genTokS: number | null;
  /** Prompt-processing tok/s as reported by the backend. */
  promptTokS: number | null;
};

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** tok/s from a token count and a duration in nanoseconds (Ollama units). */
function perSecond(count: number | null, durationNs: number | null): number | null {
  if (count === null || durationNs === null || durationNs <= 0) return null;
  return count / (durationNs / 1e9);
}

/** Extract whatever stats a single parsed JSON object carries, or null. */
function fromObject(obj: unknown): ResponseStats | null {
  if (!isRecord(obj)) return null;

  let promptTokens: number | null = null;
  let genTokens: number | null = null;
  let genTokS: number | null = null;
  let promptTokS: number | null = null;

  if (isRecord(obj.usage)) {
    promptTokens = num(obj.usage.prompt_tokens);
    genTokens = num(obj.usage.completion_tokens);
  }
  if (isRecord(obj.timings)) {
    // llama.cpp. Prefer usage counts when both exist; timings fills the gaps
    // and is the only source of backend-measured tok/s.
    promptTokens = promptTokens ?? num(obj.timings.prompt_n);
    genTokens = genTokens ?? num(obj.timings.predicted_n);
    genTokS = num(obj.timings.predicted_per_second);
    promptTokS = num(obj.timings.prompt_per_second);
  }

  // Ollama-style native timing: top-level token counts + durations in
  // nanoseconds. Jano normalizes these to tok/s so a backend speaking
  // Ollama's shape lights up the same throughput telemetry as llama.cpp.
  promptTokens = promptTokens ?? num(obj.prompt_eval_count);
  genTokens = genTokens ?? num(obj.eval_count);
  if (genTokS === null) genTokS = perSecond(num(obj.eval_count), num(obj.eval_duration));
  if (promptTokS === null) {
    promptTokS = perSecond(num(obj.prompt_eval_count), num(obj.prompt_eval_duration));
  }

  if (promptTokens === null && genTokens === null && genTokS === null && promptTokS === null) {
    return null;
  }
  return { promptTokens, genTokens, genTokS, promptTokS };
}

/** Later non-null fields win — usage/timings live in the final SSE chunk. */
function mergePreferLater(a: ResponseStats | null, b: ResponseStats): ResponseStats {
  if (!a) return b;
  return {
    promptTokens: b.promptTokens ?? a.promptTokens,
    genTokens: b.genTokens ?? a.genTokens,
    genTokS: b.genTokS ?? a.genTokS,
    promptTokS: b.promptTokS ?? a.promptTokS,
  };
}

/**
 * Parse stats from a (possibly partial) response body.
 *
 * - Non-streaming: the whole body is one JSON object.
 * - Streaming (SSE): scan `data:` frames and keep the last token/timing data
 *   we find. `[DONE]` and unparseable frames are skipped.
 */
export function parseResponseStats(text: string, isStream: boolean): ResponseStats | null {
  if (!isStream) {
    try {
      return fromObject(JSON.parse(text));
    } catch {
      return null;
    }
  }

  let acc: ResponseStats | null = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice('data:'.length).trim();
    if (payload === '' || payload === '[DONE]') continue;
    let obj: unknown;
    try {
      obj = JSON.parse(payload);
    } catch {
      continue;
    }
    const s = fromObject(obj);
    if (s) acc = mergePreferLater(acc, s);
  }
  return acc;
}
