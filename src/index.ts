import http from 'node:http';
import { Buffer } from 'node:buffer';
import { request as undiciRequest } from 'undici';
import { backendUrl, env, models } from './config.ts';
import { getStatus, start, stop } from './dispatcher.ts';
import { log } from './log.ts';
import { pickModel } from './picker.ts';
import { enqueue, type Task } from './queue.ts';

let nextId = 1;

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
