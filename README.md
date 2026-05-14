<div align="center">

<img src="assets/icon.png" alt="Jano" width="600" />

# Jano

[![CI](https://github.com/a7t-ai/jano/actions/workflows/ci.yml/badge.svg)](https://github.com/a7t-ai/jano/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node ≥23.6](https://img.shields.io/badge/node-%E2%89%A523.6-339933.svg)](https://nodejs.org/)

**A tiny OpenAI-compatible router that batches LLM requests by model, so a flurry of mixed calls costs you one swap, not five.**

https://github.com/user-attachments/assets/9d1ea1eb-873b-4da3-8c89-2204bf763647

</div>

## The interesting bit: greedy batching

Suppose six requests land within seconds, addressed to two different models, and only one model fits in memory at a time:

```
arrival:   1.chat   2.code   3.chat   4.chat   5.code   6.code
```

A naive proxy that swaps on every model change runs **3 swaps**. On local hardware that is anywhere from 30 seconds to 3 minutes of pure overhead per burst.

Jano reorders the queue. It picks the next request that matches the loaded model first, only forcing a swap when no matching request is waiting. Same arrival, same starting state:

```
served:    1.chat → 3.chat → 4.chat   ▶ swap ▶   2.code → 5.code → 6.code
```

**One swap.** That is the entire trick. The whole policy fits in three lines:

```ts
export function takeNext<T extends { model: ModelName }>(
  q: T[],
  loaded: ModelName | null
): T | null {
  if (q.length === 0) return null;
  if (loaded !== null) {
    const idx = q.findIndex((t) => t.model === loaded);
    if (idx !== -1) return q.splice(idx, 1)[0]!;
  }
  return q.shift()!;
}
```

The rest of jano is plumbing around this idea: an OpenAI-compatible HTTP front door, a tiny FIFO queue, and a hook to call your swap script when a model change is needed.

## When this is useful

- You run **two or more local LLMs** that cannot all sit in GPU/Metal memory at once (e.g. an 18 GB chat model and a 14 GB coder model on a 24 GB box, or two 28 GB models on 48 GB unified memory).
- Multiple processes call them concurrently. Without coordination, callers race over which model is loaded; with jano, the right model is guaranteed.
- You have already invested in `llama-server`, `mlx-lm.server`, vLLM, or any other OpenAI-compatible backend, and you want a small router on top rather than a full alternative stack.

If none of that applies to you, see [When you don't need jano](#when-you-dont-need-jano).

## How it works

```text
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│ caller A     │   │ caller B     │   │ caller C     │
└──────┬───────┘   └──────┬───────┘   └──────┬───────┘
       │                  │                  │
       │  POST /v1/chat/completions          │
       │  { "model": "<name>", ... }         │
       ▼                  ▼                  ▼
   ┌──────────────────────────────────────────┐
   │  jano  (default :8082)                  │
   │  - FIFO queue                            │
   │  - greedy batching (drain current first) │
   │  - swap-script invocation on demand      │
   └──┬─────────────┬─────────────┬───────────┘
      │             │             │
      ▼             ▼             ▼
   model A       model B       model C
   :8081         :8082         :8083
   ▲             ▲             ▲
   │             │             │
   └─────── exactly one is loaded at a time ───────┘
```

You declare your models in `models.json`. Each entry says: what callers should send in the `model` field, what URL hosts that backend, and any aliases.

```json
{
  "models": [
    { "name": "chat", "url": "http://127.0.0.1:8081", "aliases": ["my-chat-model"] },
    { "name": "code", "url": "http://127.0.0.1:8080", "aliases": ["my-coder-model"] },
    { "name": "fast", "url": "http://127.0.0.1:8079" }
  ]
}
```

You write a swap script that, given a model name as its argument, makes that backend the loaded one. Jano calls it whenever the queue requires it. See [the swap script contract](#the-swap-script-contract).

## Quick start

Jano needs:

1. Two or more backends speaking the OpenAI Chat Completions API (e.g. [`llama-server`](https://github.com/ggml-org/llama.cpp/tree/master/tools/server) instances on different ports).
2. A swap script that knows how to flip which backend is live.

```bash
git clone https://github.com/a7t-ai/jano.git
cd jano
npm install

cp .env.example .env
cp models.example.json models.json

$EDITOR .env             # set SWAP_COMMAND
$EDITOR models.json      # declare your backends

npm start
```

Jano listens on `127.0.0.1:8082` by default. Hit it with anything that speaks the OpenAI API:

```bash
curl http://127.0.0.1:8082/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
        "model": "chat",
        "messages": [{ "role": "user", "content": "Say hi." }]
      }'
```

If `chat` is already loaded the request is forwarded immediately. If a different model is loaded, jano calls your swap script, polls the chat backend until it is healthy, then forwards. Either way the response shape is identical to hitting the backend directly.

## API

### `POST /v1/chat/completions`

OpenAI Chat Completions, transparent passthrough. The only special handling is the `model` field: jano uses it to pick a backend, and forwards the rest of the body untouched.

`model` is matched (case-insensitively) against:

1. The exact `name` of any entry in `models.json`.
2. Any string in that entry's `aliases[]`.

Unknown values get a 400 with the list of accepted names and aliases.

Streaming (`"stream": true`) is forwarded as Server-Sent Events without buffering. Tool calls (`tools`, `tool_choice`) work transparently because jano does not touch the request body.

### `GET /v1/models`

Returns the configured models in OpenAI's list format. Useful for clients that probe the provider before sending.

### `GET /health` and `GET /status`

Both return the same payload, jano's view of the world:

```json
{
  "ok": true,
  "currentModel": "chat",
  "queueDepth": 0,
  "queueByModel": { "chat": 0, "code": 0, "fast": 0 }
}
```

## The swap script contract

Jano shells out to `SWAP_COMMAND` to swap models. The contract is intentionally small:

- **Invocation:** `<SWAP_COMMAND> <model-name>` where `<model-name>` matches one of the `name` fields in `models.json`.
- **Behaviour:** make the requested backend the live one, then exit `0`. Jano then polls that backend's `/health` until it returns `200` or `SWAP_WAIT_TIMEOUT_MS` elapses.
- **Idempotency required:** invoking the script for the already-loaded model must be a safe no-op. Jano does not check first.
- **Optional:** if your script implements a `<SWAP_COMMAND> status` subcommand that prints lines like `chat: loaded` or `code: loaded`, jano uses it at startup to detect the initial model without forcing an unnecessary swap.

The simplest implementation, on launchd:

```bash
#!/bin/bash
case "${1:-}" in
  chat)
    launchctl unload ~/Library/LaunchAgents/com.example.code.plist 2>/dev/null
    launchctl load   ~/Library/LaunchAgents/com.example.chat.plist
    ;;
  code)
    launchctl unload ~/Library/LaunchAgents/com.example.chat.plist 2>/dev/null
    launchctl load   ~/Library/LaunchAgents/com.example.code.plist
    ;;
  status)
    launchctl list | grep -q com.example.chat && echo "chat: loaded"
    launchctl list | grep -q com.example.code && echo "code: loaded"
    ;;
esac
```

For systemd, swap `launchctl` for `systemctl --user start/stop`. For Docker, `docker compose up <service>`. Anything that flips which backend owns the GPU works.

## Configuration

All via env vars; copy `.env.example` to `.env` to start.

| Var                       | Required | Default         | Notes                                                                      |
| ------------------------- | -------- | --------------- | -------------------------------------------------------------------------- |
| `SWAP_COMMAND`            | yes      |                 | Path to your swap script (see contract above).                             |
| `MODELS_FILE`             | no       | `./models.json` | Path to the model registry.                                                |
| `JANO_HOST`               | no       | `127.0.0.1`     | Use `0.0.0.0` to expose over a private network.                            |
| `JANO_PORT`               | no       | `8082`          |                                                                            |
| `SWAP_WAIT_TIMEOUT_MS`    | no       | `180000`        | Max time jano waits for a backend to become healthy after a swap.          |
| `HEALTH_POLL_INTERVAL_MS` | no       | `1000`          | How often jano pings `/health` while waiting.                              |
| `REQUEST_TIMEOUT_MS`      | no       | `600000`        | Per-request upstream timeout. Generous default for cold/large generations. |

## When you don't need jano

- **You have no backend preference yet.** Just use [Ollama](https://ollama.com). It is built on top of llama.cpp, has model management baked in (auto-load, keep-alive, parallelism), and ships with the OpenAI-compatible endpoint already. Jano is for people who have already chosen `llama-server` / `mlx-lm.server` / vLLM and want a tiny explicit router on top.
- **`llama.cpp` master with `--models-preset` (router mode).** A single `llama-server` hosts multiple models with internal LRU swap. Nicer if you are willing to maintain a source build of llama.cpp; the brew/release builds did not ship the flag at the time jano was written.
- **You only ever use one model.** Don't build a queue for a problem you don't have.

The honest pitch for jano over those alternatives:

- **Backend-agnostic.** Anything OpenAI-compatible works. Jano does not care about model formats, registry naming, or which engine you use. You can even point jano at Ollama as one of its backends, alongside a `llama-server` running custom flags.
- **Explicit swap policy.** Ollama's swap behaviour is opaque heuristics. Jano calls _your_ script. You decide what swap means.
- **Tiny.** A few hundred lines of TypeScript you can read in one sitting.
- **Greedy batching is a real algorithmic win** for the multi-caller, single-machine case, and it isn't quite what Ollama does.

## Operations

Jano is just `node src/index.ts`. Wrap it with whatever your platform gives you. The repo includes `bin/jano-run.sh` (a launchd-friendly entry point that resolves the project root from the script's location).

Logs are JSON-per-line on stdout/stderr. Pipe into `jq` for filtering:

```bash
tail -f jano.log | jq -c 'select(.msg == "swap requested" or .msg == "served")'
```

## Limits, by design

- **Single in-flight request per backend.** Jano serializes everything, even though most backends support parallel slots. This keeps the queue policy simple and matches the assumption that this is a personal box, not a multi-tenant API.
- **No fairness ceiling on greedy batching.** A long burst of one model can delay a single waiting request for another model until the burst drains. Trivial to add a max-batch counter in `src/queue.ts` if your workload needs it.
- **No client-disconnect cancellation.** If a client hangs up mid-stream, jano still finishes the upstream call. Tokens are wasted; correctness is not affected.

## Development

```bash
npm install
npm run dev               # node --watch
npm run typecheck
npm run lint
npm run format            # writes
npm run format:check      # CI uses this
npm test                  # vitest in watch mode
npm run test:run          # CI uses this
npm run test:coverage     # v8 coverage
```

## License

MIT. See [LICENSE](LICENSE).
