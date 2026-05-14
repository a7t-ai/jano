import { describe, expect, it } from 'vitest';
import { pickModel } from '../src/picker.ts';
import type { ModelDef } from '../src/types.ts';

const models: ModelDef[] = [
  {
    name: 'chat',
    url: 'http://127.0.0.1:8081',
    aliases: ['unsloth/Qwen3.6-27B-GGUF', 'qwen3.6'],
  },
  {
    name: 'code',
    url: 'http://127.0.0.1:8080',
    aliases: ['coder', 'unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF'],
  },
  {
    name: 'fast',
    url: 'http://127.0.0.1:8079',
    // Intentionally no aliases.
  },
];

describe('pickModel', () => {
  describe('exact name match', () => {
    it('routes "chat" to chat', () => {
      expect(pickModel('chat', models)).toBe('chat');
    });

    it('routes "code" to code', () => {
      expect(pickModel('code', models)).toBe('code');
    });

    it('routes "fast" to fast', () => {
      expect(pickModel('fast', models)).toBe('fast');
    });

    it('is case-insensitive on the name', () => {
      expect(pickModel('CHAT', models)).toBe('chat');
      expect(pickModel('Code', models)).toBe('code');
    });
  });

  describe('alias match', () => {
    it('routes the GGUF id to chat', () => {
      expect(pickModel('unsloth/Qwen3.6-27B-GGUF', models)).toBe('chat');
    });

    it('routes "coder" alias to code', () => {
      expect(pickModel('coder', models)).toBe('code');
    });

    it('matches aliases case-insensitively', () => {
      expect(pickModel('UNSLOTH/QWEN3.6-27B-GGUF', models)).toBe('chat');
      expect(pickModel('Qwen3.6', models)).toBe('chat');
    });

    it('a model with no aliases is reachable only by name', () => {
      expect(pickModel('fast', models)).toBe('fast');
      expect(pickModel('something-fast', models)).toBeNull();
    });
  });

  describe('rejection', () => {
    it('returns null for a model not in the list', () => {
      expect(pickModel('gpt-4', models)).toBeNull();
      expect(pickModel('claude-opus', models)).toBeNull();
    });

    it('returns null for non-string input', () => {
      expect(pickModel(undefined, models)).toBeNull();
      expect(pickModel(null, models)).toBeNull();
      expect(pickModel(42, models)).toBeNull();
      expect(pickModel({ id: 'chat' }, models)).toBeNull();
    });

    it('returns null for the empty string', () => {
      expect(pickModel('', models)).toBeNull();
    });

    it('returns null when the models list is empty', () => {
      expect(pickModel('chat', [])).toBeNull();
    });
  });

  describe('multi-model with overlapping aliases', () => {
    it('first match wins (declaration order is the tiebreaker)', () => {
      const overlapping: ModelDef[] = [
        { name: 'a', url: 'http://a', aliases: ['shared'] },
        { name: 'b', url: 'http://b', aliases: ['shared'] },
      ];
      expect(pickModel('shared', overlapping)).toBe('a');
    });
  });
});
