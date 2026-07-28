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
  startDonor,
} from './mesh.js';
import {
  createConsentLedger,
  createDonationConfig,
  createMeteringLedger,
  DONATE_COMPUTE_SCOPE,
  parsePool,
} from './index.js';

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

describe('x402 payment frames (priced hello + paid job, allow-listed)', () => {
  it('round-trips a PRICED hello (priceUsdc + payTo + chain) and a PAID job', () => {
    const hello = {
      t: 'hello',
      handle: '@donor',
      pool: 'open',
      capacityTier: 'compute',
      priceUsdc: 0.5,
      payTo: '0xabc',
      chain: 'base',
    } as const;
    expect(parseFrame(serializeFrame(hello))).toEqual(hello);
    const job = {
      t: 'job',
      id: 'j1',
      prompt: 'hi',
      payment: { payer: 'alice', amountUsdc: 0.5, txRef: 'stub:deadbeef' },
    } as const;
    expect(parseFrame(serializeFrame(job))).toEqual(job);
  });

  it('keeps a FREE hello/job at exactly their base keys (no payment leak)', () => {
    const freeHello = parseFrame(
      serializeFrame({ t: 'hello', handle: '@x', pool: 'open', capacityTier: 'compute' }),
    );
    expect(freeHello).not.toBeNull();
    expect(Object.keys(freeHello!).sort()).toEqual(['capacityTier', 'handle', 'pool', 't']);
    const freeJob = parseFrame(serializeFrame({ t: 'job', id: 'j', prompt: 'hi' }));
    expect(freeJob).not.toBeNull();
    expect(Object.keys(freeJob!).sort()).toEqual(['id', 'prompt', 't']);
  });

  it('refuses to advertise a non-positive price (privacy: free stays free) and strips extra payment fields', () => {
    // priceUsdc 0 must NOT be advertised — the hello collapses to a free hello.
    const fakeFree = parseFrame(
      JSON.stringify({ t: 'hello', handle: '@x', pool: 'open', capacityTier: 'compute', priceUsdc: 0, payTo: '0xabc' }),
    );
    expect(fakeFree).toEqual({ t: 'hello', handle: '@x', pool: 'open', capacityTier: 'compute' });
    // A hostile payment field carrying extra keys is stripped to the allow-list.
    const hostile = parseFrame(
      JSON.stringify({
        t: 'job',
        id: 'j',
        prompt: 'hi',
        payment: { payer: 'alice', amountUsdc: 0.5, txRef: 'stub:x', rawUsage: 'leak', sig: 's' },
      }),
    );
    expect(hostile).toEqual({
      t: 'job',
      id: 'j',
      prompt: 'hi',
      payment: { payer: 'alice', amountUsdc: 0.5, txRef: 'stub:x', sig: 's' },
    });
  });

  it('drops a malformed payment (keeps the job free) rather than rejecting the frame', () => {
    const kept = parseFrame(
      JSON.stringify({ t: 'job', id: 'j', prompt: 'hi', payment: { payer: '', amountUsdc: 0.5, txRef: 'stub:x' } }),
    );
    expect(kept).toEqual({ t: 'job', id: 'j', prompt: 'hi' });
  });
});

describe('startDonor x402 wiring (no sockets — refuses priced-without-wallet pre-network)', () => {
  it('refuses to JOIN as a PRICED donor without a wallet (before any network)', async () => {
    const consent = createConsentLedger();
    consent.grant(DONATE_COMPUTE_SCOPE);
    const priced = createDonationConfig({ idle: '00:00-00:00', cap: 1000, pool: 'allowlist:alice', price: 0.5 });
    await expect(
      startDonor({ handle: 'donor', config: priced, consent, ledger: createMeteringLedger() }),
    ).rejects.toThrow(/wallet/);
  });
});
