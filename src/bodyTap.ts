import { Buffer } from 'node:buffer';

/**
 * Captures just enough of a forwarded response body to extract token/timing
 * telemetry, without buffering the whole thing or perturbing what we stream
 * to the client.
 *
 * Two modes, chosen by `tailOnly`:
 *
 *   - **Streaming (`tailOnly = true`)**: keep only the last `cap` bytes. The
 *     `usage`/`timings` payload an SSE response carries always lives in the
 *     final `data:` frame, so a small tail window captures it while bounding
 *     memory regardless of how long the generation runs.
 *   - **Non-streaming (`tailOnly = false`)**: a chat-completions JSON body is
 *     small, so accumulate the whole thing — but stop at `cap` to stay safe
 *     against a pathological upstream. If we overflow we simply decline to
 *     parse (telemetry records null token counts rather than risk garbage).
 *
 * Feeding chunks is allocation-light: we hold references and only concat once,
 * lazily, in `text()`.
 */
export class BodyTap {
  private chunks: Buffer[] = [];
  private bytes = 0;
  private overflowed = false;
  private readonly tailOnly: boolean;
  private readonly cap: number;

  constructor(tailOnly: boolean, cap = 64 * 1024) {
    this.tailOnly = tailOnly;
    this.cap = cap;
  }

  push(chunk: Buffer): void {
    if (this.tailOnly) {
      this.chunks.push(chunk);
      this.bytes += chunk.length;
      // Drop from the front until we're back under cap, but always keep at
      // least the most recent chunk so a single oversized frame still parses.
      while (this.bytes > this.cap && this.chunks.length > 1) {
        const removed = this.chunks.shift();
        if (removed) this.bytes -= removed.length;
      }
      return;
    }
    if (this.overflowed) return;
    if (this.bytes + chunk.length > this.cap) {
      this.overflowed = true;
      return;
    }
    this.chunks.push(chunk);
    this.bytes += chunk.length;
  }

  /** Decoded captured bytes, or null if a non-streaming body overflowed. */
  text(): string | null {
    if (this.overflowed) return null;
    return Buffer.concat(this.chunks).toString('utf8');
  }
}
