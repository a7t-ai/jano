import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { request as undiciRequest } from 'undici';

// Bind both servers to ephemeral ports so back-to-back vitest runs aren't
// blocked by TIME_WAIT sockets from the previous run, and so the test
// rig doesn't collide with a real jano on the user's box.
const HOST = '127.0.0.1';
let JANO_PORT: number;
let UPSTREAM_PORT: number;
let JANO_BASE: string;
let tmpDir: string;

// Mock upstream: emulates a llama-server. /health returns 200; chat
// completions write large SSE-style chunks at intervals, exiting early
// if the socket is destroyed (which is what happens when jano aborts the
// upstream request after a client disconnect).
function startUpstream(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        void streamChunks(res);
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
        reject(new Error('upstream did not bind'));
        return;
      }
      UPSTREAM_PORT = addr.port;
      r(server);
    });
  });
}

// The mock upstream paces a stream of small SSE chunks over time. Small
// chunks are deliberate: what we want to verify is that, mid-stream, a
// client disconnect causes jano's pump loop to break out promptly. The
// fix's other layer — the 'close' listener on the drain promise —
// would only be hit under genuine backpressure, which is hard to provoke
// reliably across OS / Node versions; the per-iteration `res.destroyed`
// + `clientDisconnected` check catches the same hang and is what this
// test exercises.
const CHUNK_COUNT = 30;
const CHUNK_INTERVAL_MS = 50;

async function streamChunks(res: http.ServerResponse): Promise<void> {
  for (let i = 0; i < CHUNK_COUNT; i++) {
    if (res.destroyed || res.writableEnded) return;
    try {
      res.write(`data: {"chunk":${i}}\n\n`);
    } catch {
      return;
    }
    await sleep(CHUNK_INTERVAL_MS);
  }
  if (!res.writableEnded) res.end('data: [DONE]\n\n');
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
      models: [{ name: 'test', url: `http://${HOST}:${UPSTREAM_PORT}` }],
    })
  );
  const child = spawn(process.execPath, ['--experimental-strip-types', 'src/index.ts'], {
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
  return child;
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

describe('client-disconnect mid-stream (bug from 2026-05-11)', () => {
  let upstream: http.Server;
  let jano: ChildProcessByStdio<null, Readable, Readable>;
  const janoStdout: string[] = [];

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'jano-test-'));
    upstream = await startUpstream();
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
    if (upstream) await new Promise<void>((r) => upstream.close(() => r()));
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('serves a normal streaming request end to end (baseline)', async () => {
    const { statusCode, body } = await undiciRequest(`${JANO_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'test', stream: true, messages: [] }),
    });
    expect(statusCode).toBe(200);
    let chunks = 0;
    for await (const chunk of body) {
      if (chunk) chunks++;
    }
    expect(chunks).toBeGreaterThan(0);
  });

  it('a killed client mid-stream does not stall the queue', async () => {
    // Issue a streaming request and destroy the client mid-stream, then
    // verify the queue still services the next request. With the pre-fix
    // code, an unlucky disconnect during a drain-await would deadlock
    // task.run() forever and the dispatcher would never advance, so the
    // next request would hang until the test times out.
    //
    // We exercise this end-to-end against the real jano binary so the
    // production pump-loop code is what gets run. The exact socket
    // semantics around `req.on('close')` vs `res.destroyed` differ
    // between local Node, child-process Node, and the vitest runner —
    // so this test asserts the user-visible property (queue keeps
    // moving) rather than the specific log signature.
    const reqAPromise = new Promise<void>((resolveA, rejectA) => {
      const reqA = http.request(
        {
          host: HOST,
          port: JANO_PORT,
          method: 'POST',
          path: '/v1/chat/completions',
          headers: { 'Content-Type': 'application/json', Connection: 'close' },
          agent: false,
        },
        (resA) => {
          expect(resA.statusCode).toBe(200);
          resA.once('data', () => {
            resA.socket?.destroy();
            resolveA();
          });
          resA.on('error', () => {
            // Expected after destroy; ignore.
          });
        }
      );
      reqA.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') rejectA(err);
      });
      reqA.end(JSON.stringify({ model: 'test', stream: true, messages: [] }));
    });
    await reqAPromise;

    // Subsequent request must be served. If task A's run() deadlocked,
    // this hangs and the test times out — which is exactly the failure
    // mode the production bug caused.
    const b = await undiciRequest(`${JANO_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'test', stream: true, messages: [] }),
    });
    expect(b.statusCode).toBe(200);
    let chunks = 0;
    for await (const chunk of b.body) {
      if (chunk) chunks++;
    }
    expect(chunks).toBeGreaterThan(0);

    // Jano must report serving both requests; in particular the killed
    // request's served line should exist with aborted recorded. We don't
    // pin the boolean because the abort path is exercised conditionally
    // (via req.on('close') vs the res.destroyed iteration check, depending
    // on backpressure), but the `aborted` field must be present at all.
    const stdout = janoStdout.join('');
    expect(stdout).toMatch(/"msg":"served","id":"1"[^}]*"aborted":(true|false)/);
    expect(stdout).toMatch(/"msg":"served","id":"2"/);
  }, 20_000);
});
