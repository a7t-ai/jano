import http from 'node:http';
import { Buffer } from 'node:buffer';
import { request as undiciRequest } from 'undici';
import { backendUrl, env, models } from './config.ts';
import { getStatus, start, stop } from './dispatcher.ts';
import { log } from './log.ts';
import { pickModel } from './picker.ts';
import { enqueue, type Task } from './queue.ts';
import type { ModelDef, ModelName } from './types.ts';

let nextId = 1;

function modelByName(name: ModelName): ModelDef | undefined {
  return models.find((m) => m.name === name);
}

function modelsForEndpoint(endpoint: string): ModelDef[] {
  return models.filter((m) => (m.endpoints ?? ['chat/completions']).includes(endpoint));
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// Hop-by-hop headers per RFC 7230 §6.1; never forward these.
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
]);

function copyHeaders(src: Record<string, string | string[] | undefined>): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined) continue;
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Stream an arbitrary POST through to the named backend without going through
 * the queue. Safe to call from passthrough paths only — chat traffic uses
 * the enqueue path so the swap script picks up. The plumbing (abort on
 * disconnect, backpressure on writes, header copying) mirrors the in-queue
 * path so the two routes have the same disconnect / streaming behaviour.
 */
async function forwardPassthrough(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  upstream: string,
  model: ModelName,
  bodyOverride: Buffer,
): Promise<void> {
  const id = String(nextId++);
  const started = Date.now();

  const upstreamAbort = new AbortController();
  let clientDisconnected = false;
  req.on('close', () => {
    if (!res.writableEnded) {
      clientDisconnected = true;
      log.warn('client disconnected mid-stream, aborting upstream', { id, model });
      upstreamAbort.abort();
    }
  });

  const forwardHeaders: http.OutgoingHttpHeaders = {};
  if (req.headers['content-type']) forwardHeaders['content-type'] = req.headers['content-type'];
  if (req.headers['content-length']) forwardHeaders['content-length'] = req.headers['content-length'];

  try {
    const upstreamRes = await undiciRequest(upstream, {
      method: 'POST',
      headers: forwardHeaders as Record<string, string | string[]>,
      body: bodyOverride,
      bodyTimeout: env.REQUEST_TIMEOUT_MS,
      headersTimeout: env.REQUEST_TIMEOUT_MS,
      signal: upstreamAbort.signal,
    });

    if (!res.destroyed) {
      res.writeHead(upstreamRes.statusCode, copyHeaders(upstreamRes.headers));
    }
    for await (const chunk of upstreamRes.body) {
      if (clientDisconnected || res.destroyed) break;
      if (!res.write(chunk)) {
        await new Promise<void>((resolve) => {
          const done = () => {
            res.off('drain', done);
            res.off('close', done);
            resolve();
          };
          res.once('drain', done);
          res.once('close', done);
        });
        if (clientDisconnected || res.destroyed) break;
      }
    }
    if (!res.writableEnded) res.end();
    log.info('passthrough served', {
      id,
      model,
      status: upstreamRes.statusCode,
      ms: Date.now() - started,
      aborted: clientDisconnected,
    });
  } catch (err) {
    if (clientDisconnected || upstreamAbort.signal.aborted) {
      log.info('passthrough upstream aborted by client disconnect', { id, model });
      return;
    }
    log.error('passthrough failed', { id, model, err: String(err) });
    if (!res.headersSent && !res.destroyed) {
      sendJson(res, 502, { error: 'upstream failed', detail: String(err) });
    } else if (!res.writableEnded) {
      try {
        res.end();
      } catch {
        // Socket may already be gone.
      }
    }
  }
}

async function handleChatCompletions(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const raw = await readBody(req);
  let body: { model?: unknown };
  try {
    body = JSON.parse(raw.toString('utf8')) as { model?: unknown };
  } catch {
    sendJson(res, 400, { error: 'invalid JSON body' });
    return;
  }

  const model = pickModel(body.model, models);
  if (!model) {
    sendJson(res, 400, {
      error: `unknown model "${String(body.model)}"`,
      accepted: models.flatMap((m) => [m.name, ...(m.aliases ?? [])]),
    });
    return;
  }

  // Passthrough models (resident; e.g. whisper at :8084) skip the queue and
  // the swap script entirely. They can run concurrently with queued chat
  // traffic without disturbing the loaded-model invariant.
  const def = modelByName(model);
  if (def?.passthrough) {
    await forwardPassthrough(req, res, `${def.url}/v1/chat/completions`, model, raw);
    return;
  }

  const id = String(nextId++);

  // Client-disconnect guard: if the downstream client (e.g. a killed Python
  // pipeline) drops the socket mid-stream, we abort the upstream request,
  // break out of the pump loop, and let task.run() resolve so the dispatcher
  // can move on to the next task. Without this the for-await loop would
  // `await res.once('drain')` on a destroyed socket forever, freezing the
  // entire queue. Bug observed under a long-running streaming consumer.
  const upstreamAbort = new AbortController();
  let clientDisconnected = false;
  req.on('close', () => {
    if (!res.writableEnded) {
      clientDisconnected = true;
      log.warn('client disconnected mid-stream, aborting upstream', { id, model });
      upstreamAbort.abort();
    }
  });

  const task: Task = {
    id,
    model,
    enqueuedAt: Date.now(),
    isAlive: () => !clientDisconnected && !res.writableEnded && !res.destroyed,
    fail: (status, message) => {
      if (!res.headersSent && !res.destroyed) {
        sendJson(res, status, { error: message });
      } else if (!res.writableEnded) {
        try {
          res.end();
        } catch {
          // Socket may already be gone.
        }
      }
      return Promise.resolve();
    },
    run: async () => {
      const upstream = `${backendUrl(model)}/v1/chat/completions`;
      let upstreamRes: Awaited<ReturnType<typeof undiciRequest>>;
      try {
        upstreamRes = await undiciRequest(upstream, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: raw,
          bodyTimeout: env.REQUEST_TIMEOUT_MS,
          headersTimeout: env.REQUEST_TIMEOUT_MS,
          signal: upstreamAbort.signal,
        });
      } catch (err) {
        if (clientDisconnected || upstreamAbort.signal.aborted) {
          log.info('upstream aborted by client disconnect', { id, model });
          return;
        }
        throw err;
      }
      if (!res.destroyed) {
        res.writeHead(upstreamRes.statusCode, copyHeaders(upstreamRes.headers));
      }
      // Stream regardless of stream:true: undici gives us an async iterator
      // either way, and pumping it is correct for both SSE and one-shot JSON.
      try {
        for await (const chunk of upstreamRes.body) {
          if (clientDisconnected || res.destroyed) break;
          if (!res.write(chunk)) {
            await new Promise<void>((resolve) => {
              const done = () => {
                res.off('drain', done);
                res.off('close', done);
                resolve();
              };
              res.once('drain', done);
              res.once('close', done);
            });
            if (clientDisconnected || res.destroyed) break;
          }
        }
      } catch (err) {
        if (clientDisconnected || upstreamAbort.signal.aborted) {
          log.info('upstream stream aborted by client disconnect', { id, model });
          return;
        }
        throw err;
      }
      if (!res.writableEnded) res.end();
      log.info('served', {
        id,
        model,
        status: upstreamRes.statusCode,
        ms: Date.now() - task.enqueuedAt,
        aborted: clientDisconnected,
      });
    },
  };

  // Wrap so a thrown run still produces a response.
  const inner = task.run;
  task.run = async () => {
    try {
      await inner();
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, 502, { error: 'upstream failed', detail: String(err) });
      } else {
        try {
          res.end();
        } catch {
          // Socket may already be gone.
        }
      }
      throw err;
    }
  };

  enqueue(task);
  log.info('enqueued', { id, model });
}

async function handleAudioTranscriptions(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  // The model name lives inside the multipart body and we'd rather not parse
  // 200 MB of audio just to read one field. Two ways the caller can steer us
  // to a backend, both optional:
  //   1. ?model=<name>   query string
  //   2. X-Model: <name> request header
  // Otherwise we pick the first model that declares the audio/transcriptions
  // endpoint and is marked passthrough.
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const modelHint = url.searchParams.get('model') ?? req.headers['x-model'];
  const candidates = modelsForEndpoint('audio/transcriptions').filter((m) => m.passthrough);

  if (candidates.length === 0) {
    sendJson(res, 404, {
      error:
        'no audio/transcriptions backend configured. Add a model with `"endpoints": ["audio/transcriptions"]` and `"passthrough": true` to models.json.',
    });
    return;
  }

  let chosen: ModelDef | undefined;
  if (typeof modelHint === 'string' && modelHint.length > 0) {
    const matched = pickModel(modelHint, candidates);
    if (!matched) {
      sendJson(res, 400, {
        error: `unknown audio model "${modelHint}"`,
        accepted: candidates.flatMap((m) => [m.name, ...(m.aliases ?? [])]),
      });
      return;
    }
    chosen = candidates.find((m) => m.name === matched);
  } else {
    chosen = candidates[0];
  }
  if (!chosen) {
    sendJson(res, 500, { error: 'audio backend resolution failed' });
    return;
  }

  // Buffer the body first. undici's request() doesn't accept Node's
  // IncomingMessage as `body` cleanly — it expects Buffer | string | FormData |
  // Readable (web). For audio bodies (typically tens of MB even for podcasts)
  // the buffer cost is negligible compared to the model inference time.
  const raw = await readBody(req);
  await forwardPassthrough(req, res, `${chosen.url}/v1/audio/transcriptions`, chosen.name, raw);
}

function handleModels(_req: http.IncomingMessage, res: http.ServerResponse): void {
  const created = Math.floor(Date.now() / 1000);
  sendJson(res, 200, {
    object: 'list',
    data: models.map((m) => ({
      id: m.name,
      object: 'model',
      created,
      owned_by: 'jano',
      aliases: m.aliases ?? [],
    })),
  });
}

function handleStatus(_req: http.IncomingMessage, res: http.ServerResponse): void {
  sendJson(res, 200, { ok: true, ...getStatus() });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const route = `${req.method} ${url.pathname}`;
  if (route === 'POST /v1/chat/completions') {
    void handleChatCompletions(req, res);
    return;
  }
  if (route === 'POST /v1/audio/transcriptions') {
    void handleAudioTranscriptions(req, res);
    return;
  }
  if (route === 'GET /v1/models') {
    handleModels(req, res);
    return;
  }
  if (route === 'GET /status' || route === 'GET /health') {
    handleStatus(req, res);
    return;
  }
  sendJson(res, 404, { error: `no route for ${route}` });
});

await start();

server.listen(env.JANO_PORT, env.JANO_HOST, () => {
  log.info('jano listening', {
    host: env.JANO_HOST,
    port: env.JANO_PORT,
    models: models.map((m) => m.name),
  });
});

const shutdown = (sig: string): void => {
  log.info('received signal', { sig });
  stop();
  server.close(() => process.exit(0));
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
