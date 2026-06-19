import { describe, expect, it } from 'vitest';
import { parseResponseStats } from '../src/responseStats.ts';

describe('parseResponseStats (non-streaming JSON)', () => {
  it('reads OpenAI usage counts', () => {
    const body = JSON.stringify({
      choices: [{ message: { content: 'hi' } }],
      usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 },
    });
    expect(parseResponseStats(body, false)).toEqual({
      promptTokens: 12,
      genTokens: 34,
      genTokS: null,
      promptTokS: null,
    });
  });

  it('reads llama.cpp timings (tok/s come from the backend)', () => {
    const body = JSON.stringify({
      choices: [{ message: { content: 'hi' } }],
      timings: {
        prompt_n: 20,
        prompt_per_second: 250.5,
        predicted_n: 100,
        predicted_per_second: 47.2,
      },
    });
    expect(parseResponseStats(body, false)).toEqual({
      promptTokens: 20,
      genTokens: 100,
      genTokS: 47.2,
      promptTokS: 250.5,
    });
  });

  it('prefers usage counts but still takes tok/s from timings', () => {
    const body = JSON.stringify({
      usage: { prompt_tokens: 5, completion_tokens: 6 },
      timings: {
        prompt_n: 999,
        predicted_n: 999,
        predicted_per_second: 40,
        prompt_per_second: 200,
      },
    });
    expect(parseResponseStats(body, false)).toEqual({
      promptTokens: 5,
      genTokens: 6,
      genTokS: 40,
      promptTokS: 200,
    });
  });

  it('normalizes Ollama-style nanosecond timings to tok/s', () => {
    const body = JSON.stringify({
      message: { content: 'hi' },
      prompt_eval_count: 10,
      prompt_eval_duration: 50_000_000, // 50ms → 200 tok/s
      eval_count: 20,
      eval_duration: 500_000_000, // 500ms → 40 tok/s
    });
    expect(parseResponseStats(body, false)).toEqual({
      promptTokens: 10,
      genTokens: 20,
      genTokS: 40,
      promptTokS: 200,
    });
  });

  it('ignores Ollama-style zero durations rather than dividing by zero', () => {
    const body = JSON.stringify({ eval_count: 5, eval_duration: 0 });
    expect(parseResponseStats(body, false)).toEqual({
      promptTokens: null,
      genTokens: 5,
      genTokS: null,
      promptTokS: null,
    });
  });

  it('returns null when neither usage nor timings present', () => {
    expect(parseResponseStats(JSON.stringify({ choices: [] }), false)).toBeNull();
  });

  it('returns null on invalid JSON', () => {
    expect(parseResponseStats('not json', false)).toBeNull();
  });

  it('ignores non-finite numbers', () => {
    const body = JSON.stringify({ usage: { prompt_tokens: 'x', completion_tokens: null } });
    expect(parseResponseStats(body, false)).toBeNull();
  });
});

describe('parseResponseStats (SSE streaming)', () => {
  it('finds usage in the final chunk (include_usage)', () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"he"}}]}',
      '',
      'data: {"choices":[{"delta":{"content":"llo"}}]}',
      '',
      'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    expect(parseResponseStats(sse, true)).toEqual({
      promptTokens: 7,
      genTokens: 2,
      genTokS: null,
      promptTokS: null,
    });
  });

  it('finds llama.cpp timings in the trailing frame', () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"x"}}]}',
      '',
      'data: {"choices":[],"timings":{"predicted_n":3,"predicted_per_second":51.0,"prompt_n":4,"prompt_per_second":120}}',
      '',
      'data: [DONE]',
    ].join('\n');
    expect(parseResponseStats(sse, true)).toEqual({
      promptTokens: 4,
      genTokens: 3,
      genTokS: 51.0,
      promptTokS: 120,
    });
  });

  it('returns null for a stream that never reports usage', () => {
    const sse = ['data: {"choices":[{"delta":{"content":"x"}}]}', '', 'data: [DONE]'].join('\n');
    expect(parseResponseStats(sse, true)).toBeNull();
  });

  it('tolerates unparseable frames and keeps scanning', () => {
    const sse = [
      'data: {bogus',
      '',
      'data: {"usage":{"prompt_tokens":1,"completion_tokens":9}}',
      '',
      'data: [DONE]',
    ].join('\n');
    expect(parseResponseStats(sse, true)?.genTokens).toBe(9);
  });
});
