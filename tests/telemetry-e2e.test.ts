import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { request as undiciRequest } from 'undici';

// End-to-end coverage for the telemetry surface (the Ollama-gap "wedge"
// metrics): /status extras, /usage records, and /metrics Prometheus output,
// exercised against the real jano binary with two mock backends so a swap is
// actually recorded.

const HOST = '127.0.0.1';
let JANO_PORT: number;
let ALPHA_PORT: number;
let BETA_PORT: number;
let JANO_BASE: string;
let tmpDir: string;

// A mock OpenAI/llama.cpp backend: /health 200; non-streaming chat returns a
// body carrying both `usage` and llama.cpp `timings`; streaming chat emits a
// couple of SSE deltas then a final frame with usage + timings.
function startBackend(capture: (port: number) => void): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const stream = body.includes('"stream":true') || body.includes('"stream": true');
        if (stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('data: {"choices":[{"delta":{"content":"hel"}}]}\n\n');
          res.write('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n');
          res.write(
            'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":13},"timings":{"predicted_n":13,"predicted_per_second":55.5,"prompt_n":7,"prompt_per_second":300}}\n\n'
          );
          res.end('data: [DONE]\n\n');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: 'hi' } }],
            usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 },
            timings: {
              prompt_n: 11,
              prompt_per_second: 300,
              predicted_n: 22,
              predicted_per_second: 42,
            },
          })
        );
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((r, reject) => {
    server.once('error', reject);
    server.listen(0, HOST, () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('backend did not bind'));
        return;
      }
      capture(addr.port);
      r(server);
    });
  });
}

async function pickFreePort(): Promise<number> {
  const probe = http.createServer();
  return new Promise<number>((r, reject) => {
    probe.once('error', reject);
    probe.listen(0, HOST, () => {
      const addr = probe.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('probe did not bind'));
        return;
      }
      const port = addr.port;
      probe.close(() => r(port));
    });
  });
}

function startJano(): ChildProcessByStdio<null, Readable, Readable> {
  const cwd = resolve(import.meta.dirname, '..');
  const modelsFile = join(tmpDir, 'models.json');
  writeFileSync(
    modelsFile,
    JSON.stringify({
      models: [
        { name: 'alpha', url: `http://${HOST}:${ALPHA_PORT}` },
        { name: 'beta', url: `http://${HOST}:${BETA_PORT}` },
      ],
    })
  );
  return spawn(process.execPath, ['--experimental-strip-types', 'src/index.ts'], {
    cwd,
    env: {
      ...process.env,
      JANO_HOST: HOST,
      JANO_PORT: String(JANO_PORT),
      SWAP_COMMAND: resolve(cwd, 'tests/fixtures/swap-noop.sh'),
      MODELS_FILE: modelsFile,
      HEALTH_POLL_INTERVAL_MS: '50',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitForJanoReady(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${JANO_BASE}/v1/models`);
      if (res.ok) return;
    } catch {
      // Not up yet.
    }
    await sleep(50);
  }
  throw new Error(`jano did not start within ${timeoutMs}ms`);
}

async function postChat(model: string, stream = false): Promise<number> {
  const { statusCode, body } = await undiciRequest(`${JANO_BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, stream, messages: [{ role: 'user', content: 'ping' }] }),
  });
  // Drain so the request fully completes before we read telemetry.
  await body.text();
  return statusCode;
}

async function getJson(path: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const { statusCode, body } = await undiciRequest(`${JANO_BASE}${path}`);
  const text = await body.text();
  return { status: statusCode, json: JSON.parse(text) as Record<string, unknown> };
}

describe('telemetry surface (Ollama-gap wedge metrics)', () => {
  let alpha: http.Server;
  let beta: http.Server;
  let jano: ChildProcessByStdio<null, Readable, Readable>;
  const janoStdout: string[] = [];

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'jano-telemetry-'));
    alpha = await startBackend((p) => {
      ALPHA_PORT = p;
    });
    beta = await startBackend((p) => {
      BETA_PORT = p;
    });
    JANO_PORT = await pickFreePort();
    JANO_BASE = `http://${HOST}:${JANO_PORT}`;
    jano = startJano();
    jano.stdout.on('data', (b: Buffer) => janoStdout.push(b.toString('utf8')));
    jano.stderr.on('data', (b: Buffer) => janoStdout.push(b.toString('utf8')));
    await waitForJanoReady(10_000);

    // Drive traffic: alpha (initial), then beta (forces one swap), then a
    // streaming beta request (exercises the SSE body tap).
    expect(await postChat('alpha')).toBe(200);
    expect(await postChat('beta')).toBe(200);
    expect(await postChat('beta', true)).toBe(200);
  }, 25_000);

  afterAll(async () => {
    if (jano && jano.exitCode === null) {
      jano.kill('SIGTERM');
      await new Promise<void>((r) => jano.once('exit', () => r()));
    }
    if (alpha) await new Promise<void>((r) => alpha.close(() => r()));
    if (beta) await new Promise<void>((r) => beta.close(() => r()));
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET /status carries queue, swap, throughput, and counter telemetry', async () => {
    const { status, json } = await getJson('/status');
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.currentModel).toBe('beta');

    // Queue / swap economics.
    expect(json).toHaveProperty('queueByModel');
    expect(json.inFlight).toBe(0);
    expect(json.oldestWaitingMs).toBe(0);
    expect(typeof json.lastSwapDurationMs).toBe('number');
    expect(json.swapsLastHour).toBeGreaterThanOrEqual(1);
    expect(typeof json.currentModelLoadedAt).toBe('string');

    // Throughput + cumulative counters.
    expect(json.requestsServedTotal).toBe(3);
    expect(json.tokensGeneratedTotal).toBe(22 + 22 + 13);
    expect(json.recentGenTokS).toBeGreaterThan(0);
    expect(json.uptimeSeconds).toBeGreaterThanOrEqual(0);
    const tokS = json.tokSByModel as Record<string, number>;
    expect(typeof tokS.alpha).toBe('number');
    expect(typeof tokS.beta).toBe('number');

    // Health derived from successful swaps + serves.
    expect(json.backendHealth).toMatchObject({ alpha: 'up', beta: 'up' });
    expect(json.errorsLast15m).toBe(0);
    expect(json.lastError).toBeNull();
  });

  it('GET /usage returns recent per-request records, newest first', async () => {
    const { status, json } = await getJson('/usage?limit=10');
    expect(status).toBe(200);
    expect(json.count).toBe(3);
    const records = json.records as Array<Record<string, unknown>>;
    // Newest first: the streaming beta request.
    expect(records[0]!.model).toBe('beta');
    expect(records[0]!.gen_tokens).toBe(13);
    expect(records[0]!.gen_tok_s).toBe(55.5);
    // Every record has the spec'd usage-record shape.
    for (const r of records) {
      expect(r).toHaveProperty('ts');
      expect(r).toHaveProperty('status', 200);
      expect(r).toHaveProperty('total_ms');
      expect(r).toHaveProperty('prompt_tokens');
    }
  });

  it('GET /usage honours the limit', async () => {
    const { json } = await getJson('/usage?limit=1');
    expect(json.count).toBe(1);
  });

  it('GET /metrics emits Prometheus exposition', async () => {
    const { statusCode, headers, body } = await undiciRequest(`${JANO_BASE}/metrics`);
    const text = await body.text();
    expect(statusCode).toBe(200);
    expect(String(headers['content-type'])).toContain('text/plain');
    expect(text).toContain('# TYPE jano_uptime_seconds gauge');
    expect(text).toContain('jano_requests_served_total{model="alpha"}');
    expect(text).toContain('jano_requests_served_total{model="beta"}');
    expect(text).toMatch(/jano_tokens_generated_total\{model="beta"\} \d+/);
    expect(text).toContain('jano_swap_duration_milliseconds_count 1');
    expect(text).toMatch(/jano_swaps_total\{from="alpha",to="beta"\} 1/);
    expect(text).toContain('jano_backend_up{model="alpha"} 1');
  });
});
