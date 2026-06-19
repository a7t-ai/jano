import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { BodyTap } from '../src/bodyTap.ts';

describe('BodyTap', () => {
  it('non-streaming: accumulates the whole small body', () => {
    const tap = new BodyTap(false);
    tap.push(Buffer.from('{"usage":'));
    tap.push(Buffer.from('{"completion_tokens":3}}'));
    expect(tap.text()).toBe('{"usage":{"completion_tokens":3}}');
  });

  it('non-streaming: returns null once the body overflows the cap', () => {
    const tap = new BodyTap(false, 8);
    tap.push(Buffer.from('1234'));
    tap.push(Buffer.from('56789')); // pushes past cap of 8
    expect(tap.text()).toBeNull();
  });

  it('streaming: keeps only the tail within cap, preserving the final frame', () => {
    const tap = new BodyTap(true, 16);
    tap.push(Buffer.from('AAAAAAAAAAAAAAAA')); // 16 bytes, evicted by later pushes
    tap.push(Buffer.from('data: {"x":1}\n'));
    const text = tap.text();
    expect(text).not.toBeNull();
    expect(text).toContain('data: {"x":1}');
    expect(text).not.toContain('AAAA');
  });

  it('streaming: a single oversized frame is still retained', () => {
    const tap = new BodyTap(true, 4);
    const big = 'data: {"usage":{"completion_tokens":42}}';
    tap.push(Buffer.from(big));
    expect(tap.text()).toBe(big);
  });
});
