import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { request as undiciRequest } from 'undici';

// End-to-end test for the swap-failure budget added 2026-05-12 after a real
// wedge: a llama-server with a bad CLI flag KeepAlive-restart-looped, and
// every queued request paid SWAP_WAIT_TIMEOUT_MS (~3 min) before failing.
// With SWAP_FAILURE_LIMIT exceeded, further requests for that model must
// 503 immediately, and after SWAP_FAILURE_RESET_MS of quiet the budget
// resets so a recovered backend is retried automatically.

const HOST = '127.0.0.1';
let JANO_PORT: number;
let GOOD_PORT: number;
let BAD_PORT: number;
let JANO_BASE: string;
let tmpDir: string;

// Tunables for the test: swap timeout small enough that failures pile up
// in seconds, not minutes. SWAP_FAILURE_LIMIT=2 so we hit the budget on
// the 3rd dispatch. RESET_MS=600 lets us verify auto-recovery without
// stretching the test runtime.
const SWAP_WAIT_TIMEOUT_MS = 250;
const HEALTH_POLL_INTERVAL_MS = 50;
const SWAP_FAILURE_LIMIT = 2;
const SWAP_FAILURE_RESET_MS = 600;

function startGoodUpstream(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return listenEphemeral(server, (p) => {
    GOOD_PORT = p;
  });
}

// Bad upstream: /health always 503. ensureLoaded will poll until the swap
// timeout elapses, throw, and the dispatcher will record a failure.
function startBadUpstream(): Promise<http.Server> {
  const server = http.createServer((_req, res) => {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('not loaded');
  });
  return listenEphemeral(server, (p) => {
    BAD_PORT = p;
  });
}

function listenEphemeral(
  server: http.Server,
  capture: (port: number) => void
): Promise<http.Server> {
  return new Promise((r, reject) => {
    server.once('error', reject);
    server.listen(0, HOST, () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('did not bind'));
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
        { name: 'good', url: `http://${HOST}:${GOOD_PORT}` },
        { name: 'bad', url: `http://${HOST}:${BAD_PORT}` },
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
      HEALTH_POLL_INTERVAL_MS: String(HEALTH_POLL_INTERVAL_MS),
      SWAP_WAIT_TIMEOUT_MS: String(SWAP_WAIT_TIMEOUT_MS),
      SWAP_FAILURE_LIMIT: String(SWAP_FAILURE_LIMIT),
      SWAP_FAILURE_RESET_MS: String(SWAP_FAILURE_RESET_MS),
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

async function postChat(model: string): Promise<{ status: number; body: string; ms: number }> {
  const t0 = Date.now();
  const { statusCode, body } = await undiciRequest(`${JANO_BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }] }),
  });
  const text = await body.text();
  return { status: statusCode, body: text, ms: Date.now() - t0 };
}

describe('swap-failure budget (wedge fix from 2026-05-12)', () => {
  let good: http.Server;
  let bad: http.Server;
  let jano: ChildProcessByStdio<null, Readable, Readable>;
  const janoStdout: string[] = [];

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'jano-swap-fail-'));
    good = await startGoodUpstream();
    bad = await startBadUpstream();
    JANO_PORT = await pickFreePort();
    JANO_BASE = `http://${HOST}:${JANO_PORT}`;
    jano = startJano();
    jano.stdout.on('data', (b: Buffer) => janoStdout.push(b.toString('utf8')));
    jano.stderr.on('data', (b: Buffer) => janoStdout.push(b.toString('utf8')));
    jano.once('exit', (code, sig) => {
      janoStdout.push(`[jano exited code=${code} sig=${sig}]\n`);
    });
    await waitForJanoReady(10_000);
  }, 20_000);

  afterAll(async () => {
    if (jano && jano.exitCode === null) {
      jano.kill('SIGTERM');
      await new Promise<void>((r) => jano.once('exit', () => r()));
    }
    if (good) await new Promise<void>((r) => good.close(() => r()));
    if (bad) await new Promise<void>((r) => bad.close(() => r()));
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('serves "good" model end-to-end (baseline; "good" becomes currentModel)', async () => {
    const res = await postChat('good');
    expect(res.status).toBe(200);
    expect(res.body).toContain('hi');
  });

  it('first request to "bad" returns 503 after one swap-timeout window', async () => {
    const res = await postChat('bad');
    expect(res.status).toBe(503);
    // Took at least one swap-timeout but not absurdly more.
    expect(res.ms).toBeGreaterThanOrEqual(SWAP_WAIT_TIMEOUT_MS - 50);
    expect(res.ms).toBeLessThan(SWAP_WAIT_TIMEOUT_MS * 4);
    expect(res.body).toMatch(/swap to .*bad.* failed|backend .*bad.* is unavailable/);
  });

  it('second failure trips the budget; "good" still works in between', async () => {
    // After this, swapFailures.count('bad') should be 2 (== SWAP_FAILURE_LIMIT).
    const res = await postChat('bad');
    expect(res.status).toBe(503);
    // Sanity: a "good" call still succeeds — the budget is per-model.
    const g = await postChat('good');
    expect(g.status).toBe(200);
  });

  it('third "bad" request fails fast (no swap attempt, sub-100ms)', async () => {
    const res = await postChat('bad');
    expect(res.status).toBe(503);
    expect(res.body).toMatch(/unavailable .*consecutive swap failures/);
    // The swap timeout is 250ms; if fail-fast is wired up correctly, this
    // returns in well under that. Generous bound for slow CI.
    expect(res.ms).toBeLessThan(SWAP_WAIT_TIMEOUT_MS);
  });

  it('after SWAP_FAILURE_RESET_MS of quiet, "bad" is retried (auto-recovery)', async () => {
    // Wait past the reset window. We need (now - lastAt) > SWAP_FAILURE_RESET_MS,
    // and lastAt was updated on the most recent failure.
    await sleep(SWAP_FAILURE_RESET_MS + 200);
    const res = await postChat('bad');
    expect(res.status).toBe(503);
    // It actually attempted the swap again, so this took roughly a full
    // swap-timeout window — proving the budget cleared and the dispatcher
    // didn't fail-fast.
    expect(res.ms).toBeGreaterThanOrEqual(SWAP_WAIT_TIMEOUT_MS - 50);
  });

  it('"good" still works after all the failure churn', async () => {
    const res = await postChat('good');
    expect(res.status).toBe(200);
    expect(res.body).toContain('hi');
  });

  it('jano log records the fail-fast event', () => {
    const stdout = janoStdout.join('');
    expect(stdout).toMatch(/"msg":"failing fast: backend marked bad"/);
    // And the underlying swap failures that led to it.
    expect(stdout).toMatch(/"msg":"swap failed".*"model":"bad"/);
  });
});
