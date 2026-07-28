/**
 * Pure unit tests for the mesh transport's allow-listed surfaces — no sockets,
 * no DHT. The live multi-node behavior is covered by mesh.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';

import {
  createEchoModel,
  DEFAULT_JOB_TOKEN_COST,
  MAX_PROMPT_LEN,
  parseFrame,
  poolTopic,
  poolTopicKey,
  randomTopic,
  serializeFrame,
} from './mesh.js';
import { parsePool } from './index.js';

describe('poolTopicKey / poolTopic (deterministic discovery label)', () => {
  it('maps each pool kind to a stable key', () => {
    expect(poolTopicKey(parsePool('open'))).toBe('open');
    expect(poolTopicKey(parsePool('org:acme,alice,bob'))).toBe('org:acme');
    expect(poolTopicKey(parsePool('allowlist:bob,alice'))).toBe('allowlist:alice,bob');
  });

  it('sorts allowlist members so any member set shares a topic', () => {
    expect(poolTopicKey(parsePool('allowlist:b,a'))).toBe(poolTopicKey(parsePool('allowlist:a,b')));
  });

  it('hashes the same pool to the same 32-byte topic, different pools differ', () => {
    const a = poolTopic(parsePool('open'));
    const a2 = poolTopic(parsePool('open'));
    const b = poolTopic(parsePool('org:other'));
    expect(a.equals(a2)).toBe(true);
    expect(a.length).toBe(32);
    expect(a.equals(b)).toBe(false);
  });

  it('randomTopic is 32 bytes and never equals a real pool topic', () => {
    const r = randomTopic();
    expect(r.length).toBe(32);
    expect(r.equals(poolTopic(parsePool('open')))).toBe(false);
  });
});

describe('parseFrame / serializeFrame (allow-list discipline)', () => {
  it('round-trips every frame type', () => {
    const frames = [
      { t: 'hello', handle: '@alice', pool: 'open', capacityTier: 'compute' },
      { t: 'job', id: 'abc', prompt: 'reverse me' },
      { t: 'result', id: 'abc', output: 'em esrever' },
      { t: 'result', id: 'abc', output: '', denied: true, reason: 'not authorized' },
    ] as const;
    for (const f of frames) {
      expect(parseFrame(serializeFrame(f))).toEqual(f);
    }
  });

  it('drops unknown / extra fields a peer sneaks in (no raw-usage leak)', () => {
    // A hostile hello carrying raw usage + system fields.
    const hostile = JSON.stringify({
      t: 'hello',
      handle: '@mallory',
      pool: 'open',
      capacityTier: 'compute',
      totalTokens: 999_000_000,
      rawUsage: { everything: true },
      system: { os: 'darwin', keys: ['sk-...'] },
    });
    const parsed = parseFrame(hostile);
    expect(parsed).not.toBeNull();
    expect(parsed!.t).toBe('hello');
    expect(Object.keys(parsed!).sort()).toEqual(['capacityTier', 'handle', 'pool', 't']);
  });

  it('defaults a missing/blank capacityTier to "compute"', () => {
    const parsed = parseFrame(JSON.stringify({ t: 'hello', handle: '@x', pool: 'open' }));
    expect(parsed).toEqual({ t: 'hello', handle: '@x', pool: 'open', capacityTier: 'compute' });
  });

  it('rejects malformed frames (bad json / wrong shapes / oversized)', () => {
    expect(parseFrame('not json')).toBeNull();
    expect(parseFrame('{}')).toBeNull(); // no t
    expect(parseFrame(JSON.stringify({ t: 'unknown' }))).toBeNull();
    expect(parseFrame(JSON.stringify({ t: 'job' }))).toBeNull(); // missing id/prompt
    expect(parseFrame(JSON.stringify({ t: 'job', id: 'x' }))).toBeNull(); // missing prompt
    expect(parseFrame(JSON.stringify({ t: 'result', id: 'x' }))).toBeNull(); // missing output
    // oversize prompt
    const big = 'x'.repeat(MAX_PROMPT_LEN + 1);
    expect(parseFrame(JSON.stringify({ t: 'job', id: 'x', prompt: big }))).toBeNull();
    // non-true denied flag is rejected
    expect(parseFrame(JSON.stringify({ t: 'result', id: 'x', output: '', denied: 'yes' }))).toBeNull();
  });

  it('serializeFrame never emits undefined optional fields', () => {
    const s = serializeFrame({ t: 'result', id: 'x', output: 'ok' });
    expect(s).not.toContain('denied');
    expect(s).not.toContain('reason');
    expect(s).not.toContain('undefined');
  });
});

describe('createEchoModel (v0 deterministic stub)', () => {
  it('reverses the prompt and charges the fixed token cost', () => {
    const m = createEchoModel();
    const r = m.run('hello');
    expect(r.output).toBe('olleh');
    expect(r.tokens).toBe(DEFAULT_JOB_TOKEN_COST);
  });

  it('is deterministic — same prompt always yields the same output', () => {
    const m = createEchoModel();
    expect(m.run('vibedonate').output).toBe(m.run('vibedonate').output);
  });

  it('honors a custom token cost (floored to ≥1)', () => {
    expect(createEchoModel(250).run('x').tokens).toBe(250);
    expect(createEchoModel(0).run('x').tokens).toBe(1);
  });

  it('stamps a stable model id for receipts', () => {
    expect(createEchoModel().id).toBe('echo-stub');
  });
});
