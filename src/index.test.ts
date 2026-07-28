import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  authorizePeer,
  createConsentLedger,
  createDonationConfig,
  createDonationHooks,
  createHookBus,
  createLocalMeshRuntime,
  createMeteringLedger,
  createOllamaChatRunner,
  DONATE_COMPUTE_SCOPE,
  evaluateCapacity,
  isSharingActive,
  makeEvent,
  parseCap,
  parseIdleWindow,
  parsePool,
  publishDonationEvent,
  resolveCompute,
  withinIdleWindow,
  type LabeledRunner,
  type MeteringStore,
  type SystemDeps,
} from './index.js';

function config(opts: {
  enabled?: boolean;
  idle?: string;
  cap?: number;
  pool?: string;
} = {}) {
  return createDonationConfig({
    idle: opts.idle ?? '22:00-07:00',
    cap: opts.cap ?? 2_000_000,
    pool: opts.pool ?? 'allowlist:alice,bob',
    enabled: opts.enabled ?? true,
  });
}

/** UTC date for `HH:MM` on a fixed day (cap-windowing is day-bucketed → fix the day). */
function at(hh: number, mm: number): Date {
  return new Date(Date.UTC(2026, 0, 15, hh, mm, 0));
}

describe('createDonationConfig', () => {
  it('builds a valid config from canonical options', () => {
    const c = config({ idle: '22:00-07:00', cap: 2_000_000, pool: 'allowlist:alice,bob' });
    expect(c.tier).toBe('compute');
    expect(c.enabled).toBe(true);
    expect(c.idle).toEqual({ start: '22:00', end: '07:00' });
    expect(c.pool).toEqual({ kind: 'allowlist', peers: ['alice', 'bob'] });
    expect(c.cap).toBe(2_000_000);
  });

  it('accepts cap shorthand (2M / 500k)', () => {
    expect(createDonationConfig({ idle: '22:00-07:00', cap: '2M', pool: 'open' }).cap).toBe(2_000_000);
    expect(createDonationConfig({ idle: '22:00-07:00', cap: '500k', pool: 'open' }).cap).toBe(500_000);
  });

  it('defaults to FREE (priceUsdc 0, base chain) when no --price is given', () => {
    const c = createDonationConfig({ idle: '22:00-07:00', cap: 1000, pool: 'open' });
    expect(c.priceUsdc).toBe(0);
    expect(c.chain).toBe('base');
  });

  it('arms the payment gate for a priced config (number or decimal string)', () => {
    expect(createDonationConfig({ idle: '22:00-07:00', cap: 1000, pool: 'open', price: 0.001 }).priceUsdc).toBe(0.001);
    expect(createDonationConfig({ idle: '22:00-07:00', cap: 1000, pool: 'open', price: '1.5' }).priceUsdc).toBe(1.5);
    expect(createDonationConfig({ idle: '22:00-07:00', cap: 1000, pool: 'open', price: 0, chain: 'polygon' }).priceUsdc).toBe(0);
  });

  it('rejects a non-positive / malformed price', () => {
    expect(() => createDonationConfig({ idle: '22:00-07:00', cap: 1000, pool: 'open', price: -1 })).toThrow(/positive/);
    expect(() => createDonationConfig({ idle: '22:00-07:00', cap: 1000, pool: 'open', price: 'free' })).toThrow(/invalid price/);
  });

  it('rejects non-compute tiers (v0 is compute-only)', () => {
    expect(() =>
      createDonationConfig({ idle: '22:00-07:00', cap: 1000, pool: 'open', tier: 'credits' as never }),
    ).toThrow(/compute/);
  });

  it('rejects bad idle / cap / pool inputs', () => {
    expect(() => createDonationConfig({ idle: 'bad', cap: 1000, pool: 'open' })).toThrow();
    expect(() => createDonationConfig({ idle: '22:00-07:00', cap: 0, pool: 'open' })).toThrow();
    expect(() => createDonationConfig({ idle: '22:00-07:00', cap: -5, pool: 'open' })).toThrow();
    expect(() => createDonationConfig({ idle: '22:00-07:00', cap: 1000, pool: 'nonsense:foo' })).toThrow();
    expect(() => createDonationConfig({ idle: '22:00-07:00', cap: 1000, pool: 'allowlist:' })).toThrow();
  });
});

describe('parseCap / parseIdleWindow / parsePool', () => {
  it('parseCap floors and rejects non-positive', () => {
    expect(parseCap(2_000_000)).toBe(2_000_000);
    expect(parseCap('1.5M')).toBe(1_500_000);
    expect(() => parseCap('abc')).toThrow();
    expect(() => parseCap(0)).toThrow();
  });
  it('parseIdleWindow normalizes whitespace and validates', () => {
    expect(parseIdleWindow(' 22:00 - 07:00 ')).toEqual({ start: '22:00', end: '07:00' });
    expect(() => parseIdleWindow('22:00')).toThrow();
    expect(() => parseIdleWindow('25:00-07:00')).toThrow();
  });
  it('parsePool handles open / org / allowlist', () => {
    expect(parsePool('open')).toEqual({ kind: 'open' });
    expect(parsePool('org:acme')).toEqual({ kind: 'org', id: 'acme', members: [] });
    expect(parsePool('org:acme,alice,bob')).toEqual({ kind: 'org', id: 'acme', members: ['alice', 'bob'] });
    expect(parsePool('allowlist:alice,bob')).toEqual({ kind: 'allowlist', peers: ['alice', 'bob'] });
    expect(() => parsePool('allowlist:')).toThrow();
  });
});

describe('withinIdleWindow', () => {
  const window = parseIdleWindow('22:00-07:00');
  it('wraps midnight', () => {
    expect(withinIdleWindow(window, at(23, 30))).toBe(true);
    expect(withinIdleWindow(window, at(2, 0))).toBe(true);
    expect(withinIdleWindow(window, at(7, 0))).toBe(false); // end-exclusive
    expect(withinIdleWindow(window, at(12, 0))).toBe(false);
    expect(withinIdleWindow(window, at(22, 0))).toBe(true); // start-inclusive
  });
  it('handles non-wrapping window', () => {
    const w = parseIdleWindow('09:00-17:00');
    expect(withinIdleWindow(w, at(12, 0))).toBe(true);
    expect(withinIdleWindow(w, at(8, 59))).toBe(false);
    expect(withinIdleWindow(w, at(17, 0))).toBe(false);
  });
  it('degenerate equal start/end is always active', () => {
    const w = parseIdleWindow('00:00-00:00');
    expect(withinIdleWindow(w, at(3, 0))).toBe(true);
  });
});

describe('isSharingActive (the core gate)', () => {
  it('is active inside the window, under cap, not busy, enabled', () => {
    expect(isSharingActive(config(), at(23, 0), false, 0)).toBe(true);
  });

  it('is inactive outside the idle window', () => {
    expect(isSharingActive(config(), at(12, 0), false, 0)).toBe(false);
  });

  it('is inactive when the daily cap is reached or exceeded', () => {
    const c = config({ cap: 1_000 });
    expect(isSharingActive(c, at(23, 0), false, 999)).toBe(true);
    expect(isSharingActive(c, at(23, 0), false, 1_000)).toBe(false); // at cap
    expect(isSharingActive(c, at(23, 0), false, 5_000)).toBe(false); // over cap
  });

  it('is inactive while local activity is detected (systemBusy)', () => {
    expect(isSharingActive(config(), at(23, 0), true, 0)).toBe(false);
  });

  it('is inactive when stopped (enabled=false)', () => {
    expect(isSharingActive(config({ enabled: false }), at(23, 0), false, 0)).toBe(false);
  });

  it('defaults donatedToday to 0 (3-arg form answers the schedule question)', () => {
    expect(isSharingActive(config(), at(23, 0), false)).toBe(true);
  });
});

describe('authorizePeer', () => {
  it('allowlist: allow members, deny others', () => {
    const c = config({ pool: 'allowlist:alice,bob' });
    expect(authorizePeer(c, 'alice')).toBe('allow');
    expect(authorizePeer(c, 'bob')).toBe('allow');
    expect(authorizePeer(c, 'eve')).toBe('deny');
  });
  it('open pool allows everyone', () => {
    const c = config({ pool: 'open' });
    expect(authorizePeer(c, 'anyone')).toBe('allow');
  });
  it('org pool checks its members list (empty = deny all)', () => {
    const empty = config({ pool: 'org:acme' });
    expect(authorizePeer(empty, 'alice')).toBe('deny');
    const withMembers = config({ pool: 'org:acme,alice,bob' });
    expect(authorizePeer(withMembers, 'alice')).toBe('allow');
    expect(authorizePeer(withMembers, 'eve')).toBe('deny');
  });
});

describe('createMeteringLedger', () => {
  it('records receipts with a hash-chain and tracks totals', () => {
    const ledger = createMeteringLedger();
    const a = ledger.record({ peer: 'alice', tokens: 500, model: 'qwen2.5' });
    const b = ledger.record({ peer: 'alice', tokens: 250, model: 'qwen2.5' });
    const c = ledger.record({ peer: 'bob', tokens: 100, model: 'qwen2.5', direction: 'received' });

    expect(a.seq).toBe(0);
    expect(b.prev).toBe(a.hash);
    expect(c.prev).toBe(b.hash);
    const totals = ledger.totals(new Date(a.ts));
    expect(totals.donated).toBe(750);
    expect(totals.donatedToday).toBe(750); // a.ts is today
    expect(totals.received).toBe(100);
    expect(totals.count).toBe(3);
    expect(ledger.verify()).toBe(true);
  });

  it('enforces the cap via remainingToday', () => {
    const ledger = createMeteringLedger();
    ledger.record({ peer: 'alice', tokens: 800, model: 'm' });
    const cap = 1_000;
    expect(ledger.remainingToday(cap, new Date())).toBe(200);
    ledger.record({ peer: 'alice', tokens: 200, model: 'm' });
    expect(ledger.remainingToday(cap, new Date())).toBe(0);
  });

  it('donatedToday is scoped to the same UTC day', () => {
    const ledger = createMeteringLedger();
    const earlier = new Date(Date.UTC(2026, 0, 14, 23, 0)).toISOString();
    ledger.record({ peer: 'alice', tokens: 1_000, model: 'm', ts: earlier });
    const today = new Date(Date.UTC(2026, 0, 15, 12, 0));
    // The earlier receipt was on the 14th, not "today" (15th).
    expect(ledger.totals(today).donated).toBe(1_000);
    expect(ledger.totals(today).donatedToday).toBe(0);
  });

  it('detects tampering (verify fails on mutation)', () => {
    // Intercept the saved array so we can mutate it before reload.
    let saved: ReturnType<MeteringStore['load']> = [];
    const store: MeteringStore = {
      load: () => saved,
      save: (r) => {
        saved = r.slice();
      },
    };
    const ledger = createMeteringLedger(store);
    ledger.record({ peer: 'alice', tokens: 500, model: 'm' });
    ledger.record({ peer: 'bob', tokens: 500, model: 'm' });
    expect(ledger.verify()).toBe(true);

    // Tamper: bump a token count. Reload into a fresh ledger and the chain breaks.
    saved = saved.map((r, i) => (i === 0 ? { ...r, tokens: 999 } : r));
    const tampered = createMeteringLedger(store);
    expect(tampered.verify()).toBe(false);
  });

  it('rejects non-positive or missing receipt fields', () => {
    const ledger = createMeteringLedger();
    expect(() => ledger.record({ peer: 'alice', tokens: 0, model: 'm' })).toThrow();
    expect(() => ledger.record({ peer: '', tokens: 5, model: 'm' })).toThrow();
    expect(() => ledger.record({ peer: 'alice', tokens: 5, model: '' })).toThrow();
  });
});

describe('consent integration (donate:compute scope)', () => {
  it('createConsentLedger gates the scope; revoke is instant', () => {
    const ledger = createConsentLedger();
    expect(ledger.allows(DONATE_COMPUTE_SCOPE)).toBe(false);
    ledger.grant(DONATE_COMPUTE_SCOPE);
    expect(ledger.allows(DONATE_COMPUTE_SCOPE)).toBe(true);
    ledger.revoke(DONATE_COMPUTE_SCOPE);
    expect(ledger.allows(DONATE_COMPUTE_SCOPE)).toBe(false);
  });
});

describe('evaluateCapacity (the shared gate)', () => {
  function granted() {
    const c = createConsentLedger();
    c.grant(DONATE_COMPUTE_SCOPE);
    return c;
  }
  const ctx = (over: Partial<{ now: Date; systemBusy: boolean; donatedToday: number; localAvailable: boolean }> = {}) => ({
    now: over.now ?? at(23, 0),
    systemBusy: over.systemBusy ?? false,
    donatedToday: over.donatedToday ?? 0,
    localAvailable: over.localAvailable ?? true,
  });

  it('allows when every condition is green', () => {
    const v = evaluateCapacity(config(), granted(), 'alice', 100, ctx());
    expect(v.decision).toBe('allow');
    expect(v.reason).toMatch(/remain after/);
  });
  it('denies when stopped', () => {
    expect(evaluateCapacity(config({ enabled: false }), granted(), 'alice', 100, ctx()).decision).toBe('deny');
  });
  it('denies without the consent grant', () => {
    expect(evaluateCapacity(config(), createConsentLedger(), 'alice', 100, ctx()).decision).toBe('deny');
  });
  it('denies a peer not in the pool', () => {
    expect(evaluateCapacity(config(), granted(), 'eve', 100, ctx()).decision).toBe('deny');
  });
  it('denies when no on-device model is available', () => {
    expect(evaluateCapacity(config(), granted(), 'alice', 100, ctx({ localAvailable: false })).decision).toBe('deny');
  });
  it('denies while local activity is in progress', () => {
    expect(evaluateCapacity(config(), granted(), 'alice', 100, ctx({ systemBusy: true })).decision).toBe('deny');
  });
  it('denies outside the idle window', () => {
    expect(evaluateCapacity(config(), granted(), 'alice', 100, ctx({ now: at(12, 0) })).decision).toBe('deny');
  });
  it('denies when the daily cap is reached', () => {
    const c = config({ cap: 1_000 });
    expect(evaluateCapacity(c, granted(), 'alice', 100, ctx({ donatedToday: 1_000 })).decision).toBe('deny');
  });
  it('denies when the request exceeds the remaining headroom', () => {
    const c = config({ cap: 1_000 });
    const v = evaluateCapacity(c, granted(), 'alice', 500, ctx({ donatedToday: 600 }));
    expect(v.decision).toBe('deny');
    expect(v.reason).toMatch(/400 tokens remain/);
  });
  it('checks in the documented precedence order (model before window)', () => {
    // No model AND outside window → the model reason wins (checked earlier).
    const v = evaluateCapacity(config(), granted(), 'alice', 100, ctx({ localAvailable: false, now: at(12, 0) }));
    expect(v.reason).toMatch(/local chat model/);
  });
});

describe('resolveCompute (cascade-backed)', () => {
  function fakeRunner(available: boolean): LabeledRunner {
    return {
      id: 'fake · unit',
      capability: 'chat',
      available: async () => available,
      generate: async <TReq = unknown, TOut = unknown>(_req: TReq): Promise<TOut> =>
        ({ ok: true }) as TOut,
    };
  }

  it('resolves to an available on-device runner, egress forbidden', async () => {
    const r = await resolveCompute({ runners: [fakeRunner(true)] });
    expect(r.available).toBe(true);
    expect(r.tier).toBe('local');
    expect(r.egress).toBe(false);
    expect(r.label).toBe('fake · unit');
    expect(r.runner).toBeDefined();
  });

  it('reports unavailable when no runner is ready', async () => {
    const r = await resolveCompute({ runners: [fakeRunner(false)] });
    expect(r.available).toBe(false);
    expect(r.egress).toBe(false);
    expect(r.label).toMatch(/no local chat model/);
    expect(r.runner).toBeUndefined();
  });

  it('reports unavailable when pickLocal returns null', async () => {
    const r = await resolveCompute({ pickLocal: async () => null });
    expect(r.available).toBe(false);
  });
});

describe('createOllamaChatRunner', () => {
  const yes: SystemDeps = { detect: async (b) => b === 'ollama', run: async () => undefined };
  const no: SystemDeps = { detect: async () => false, run: async () => undefined };

  it('detects ollama on PATH and exposes the chat capability', async () => {
    const r = createOllamaChatRunner(yes, 'qwen2.5:7b');
    expect(r.capability).toBe('chat');
    expect(r.id).toBe('ollama · qwen2.5:7b');
    expect(await r.available()).toBe(true);
    expect(await createOllamaChatRunner(no).available()).toBe(false);
  });

  it('generate shells out and returns stdout (via injectable exec)', async () => {
    const calls: string[][] = [];
    const exec = async (bin: string, args: readonly string[]) => {
      calls.push([bin, ...args]);
      return { stdout: 'generated text', stderr: '' };
    };
    const r = createOllamaChatRunner(yes, 'qwen2.5:7b', exec);
    const out = await r.generate({ prompt: 'hi' });
    expect(out).toEqual({ model: 'qwen2.5:7b', output: 'generated text' });
    expect(calls[0]).toEqual(['ollama', 'run', 'qwen2.5:7b', 'hi']);
  });
});

describe('createLocalMeshRuntime (the runtime that commits)', () => {
  function setup(over: Partial<{ cap: number; enabled: boolean; local: boolean; donatedToday: number }> = {}) {
    const cfg = config({ cap: over.cap ?? 2_000_000, enabled: over.enabled ?? true });
    const consent = createConsentLedger();
    consent.grant(DONATE_COMPUTE_SCOPE);
    const ledger = createMeteringLedger();
    const now = () => at(23, 0);
    const rt = createLocalMeshRuntime({
      config: () => cfg,
      consent: () => consent,
      ledger: () => ledger,
      now,
      systemBusy: () => false,
      resolveLocal: async () => ({
        tier: 'local',
        egress: false,
        available: over.local ?? true,
        label: 'fake · unit',
      }),
    });
    return { cfg, consent, ledger, rt };
  }

  it('allows + commits a hash-chained receipt on allow', async () => {
    const { ledger, rt } = setup();
    const v = await rt.serve({ peer: 'alice', tokens: 250 });
    expect(v.decision).toBe('allow');
    expect(v.receipt).toBeDefined();
    expect(ledger.all()).toHaveLength(1);
    expect(ledger.verify()).toBe(true);
    expect(ledger.totals().donated).toBe(250);
  });

  it('denies an unauthorized peer without recording', async () => {
    const { ledger, rt } = setup();
    const v = await rt.serve({ peer: 'eve', tokens: 10 });
    expect(v.decision).toBe('deny');
    expect(v.receipt).toBeUndefined();
    expect(ledger.all()).toHaveLength(0);
  });

  it('denies when no on-device model is available', async () => {
    const { ledger, rt } = setup({ local: false });
    const v = await rt.serve({ peer: 'alice', tokens: 10 });
    expect(v.decision).toBe('deny');
    expect(v.reason).toMatch(/local chat model/);
    expect(ledger.all()).toHaveLength(0);
  });

  it('denies past the daily cap without recording', async () => {
    const { ledger, rt } = setup({ cap: 1_000, donatedToday: 0 });
    // Pre-load the ledger to the cap so the runtime sees donatedToday === cap.
    ledger.record({ peer: 'alice', tokens: 1_000, model: 'm', ts: at(23, 0).toISOString() });
    const v = await rt.serve({ peer: 'alice', tokens: 1 });
    expect(v.decision).toBe('deny');
    expect(v.reason).toMatch(/daily cap/);
    expect(ledger.all()).toHaveLength(1); // only the pre-record, no new commit
  });

  it('rejects non-positive token requests', async () => {
    const { rt } = setup();
    expect((await rt.serve({ peer: 'alice', tokens: 0 })).decision).toBe('deny');
    expect((await rt.serve({ peer: 'alice', tokens: -5 })).decision).toBe('deny');
  });
});

describe('donation hooks + notify channel', () => {
  let dir: string;
  it('creates a fresh temp notify dir per test', () => {
    dir = mkdtempSync(join(tmpdir(), 'vdb-hooks-'));
    expect(dir.length).toBeGreaterThan(0);
  });

  it('publishDonationEvent appends a normalized VibeEvent to the channel', () => {
    const file = join(dir, 'notify.jsonl');
    publishDonationEvent('share', { tier: 'compute' }, { cwd: '/repo', file });
    publishDonationEvent('stop', undefined, { cwd: '/repo', file });
    const lines = readFileSync(file, 'utf8').trim().split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!) as { kind: string; agent: string; cwd: string; payload: { action: string; tier?: string } };
    expect(first.kind).toBe('manual');
    expect(first.agent).toBe('vibedonate');
    expect(first.cwd).toBe('/repo');
    expect(first.payload.action).toBe('share');
    expect(first.payload.tier).toBe('compute');
    expect((JSON.parse(lines[1]!) as { payload: { action: string } }).payload.action).toBe('stop');
  });

  it('createDonationHooks publishes and reacts to session-end', async () => {
    const file = join(dir, 'session.jsonl');
    let stops = 0;
    const bus = createHookBus();
    const hooks = createDonationHooks(bus, { onStop: () => { stops += 1; }, cwd: '/repo', file });
    hooks.publish('serve', { peer: 'alice', tokens: 10 });
    // A harness session-end milestone stops donation.
    await bus.emit(makeEvent('session-end', 'claude-code', '/repo'));
    expect(stops).toBe(1);
    // dispose makes the handler inert.
    hooks.dispose();
    await bus.emit(makeEvent('session-end', 'claude-code', '/repo'));
    expect(stops).toBe(1);
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines.length).toBe(1);
  });

  it('cleans up the temp dir', () => {
    rmSync(dir, { recursive: true, force: true });
    expect(dir.length).toBeGreaterThan(0); // sanity
  });
});
