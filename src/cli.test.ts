import { describe, expect, it } from 'vitest';

import { parseArgs } from './cli.js';

describe('parseArgs', () => {
  it('routes global flags', () => {
    expect(parseArgs([])).toEqual({ kind: 'help' });
    expect(parseArgs(['--help'])).toEqual({ kind: 'help' });
    expect(parseArgs(['-h'])).toEqual({ kind: 'help' });
    expect(parseArgs(['--version'])).toEqual({ kind: 'version' });
    expect(parseArgs(['-v'])).toEqual({ kind: 'version' });
  });

  it('routes simple commands', () => {
    expect(parseArgs(['status'])).toEqual({ kind: 'status' });
    expect(parseArgs(['stop'])).toEqual({ kind: 'stop' });
    expect(parseArgs(['mcp'])).toEqual({ kind: 'mcp' });
  });

  it('parses the canonical share command into a validated config', () => {
    const cmd = parseArgs([
      'share',
      '--compute',
      '--idle',
      '22:00-07:00',
      '--cap',
      '2000000',
      '--pool',
      'allowlist:alice,bob',
    ]);
    expect(cmd.kind).toBe('share');
    if (cmd.kind !== 'share') return;
    expect(cmd.config.tier).toBe('compute');
    expect(cmd.config.idle).toEqual({ start: '22:00', end: '07:00' });
    expect(cmd.config.cap).toBe(2_000_000);
    expect(cmd.config.pool).toEqual({ kind: 'allowlist', peers: ['alice', 'bob'] });
    expect(cmd.config.enabled).toBe(true);
  });

  it('accepts --cap 2M shorthand and =-joined flags', () => {
    const cmd = parseArgs([
      'share',
      '--compute',
      '--idle=09:00-17:00',
      '--cap=2M',
      '--pool=open',
    ]);
    expect(cmd.kind).toBe('share');
    if (cmd.kind !== 'share') return;
    expect(cmd.config.cap).toBe(2_000_000);
    expect(cmd.config.idle).toEqual({ start: '09:00', end: '17:00' });
    expect(cmd.config.pool).toEqual({ kind: 'open' });
  });

  it('requires --compute (v0 is compute-only)', () => {
    expect(() =>
      parseArgs(['share', '--idle', '22:00-07:00', '--cap', '1000', '--pool', 'open']),
    ).toThrow(/compute/);
  });

  it('requires all share options', () => {
    expect(() => parseArgs(['share', '--compute', '--cap', '1000', '--pool', 'open'])).toThrow(/--idle/);
    expect(() => parseArgs(['share', '--compute', '--idle', '22:00-07:00', '--pool', 'open'])).toThrow(/--cap/);
    expect(() => parseArgs(['share', '--compute', '--idle', '22:00-07:00', '--cap', '1000'])).toThrow(/--pool/);
  });

  it('rejects unknown commands and unexpected options', () => {
    expect(() => parseArgs(['frobnicate'])).toThrow(/unknown command/);
    expect(() =>
      parseArgs(['share', '--compute', '--idle', '22:00-07:00', '--cap', '1000', '--pool', 'open', '--bogus']),
    ).toThrow(/unexpected option/);
  });

  it('surfaces validation errors from createDonationConfig (bad idle)', () => {
    expect(() =>
      parseArgs(['share', '--compute', '--idle', 'nope', '--cap', '1000', '--pool', 'open']),
    ).toThrow();
  });

  it('share accepts an optional --handle (defaults to hostname when omitted)', () => {
    const withHandle = parseArgs([
      'share', '--compute', '--idle', '22:00-07:00', '--cap', '1000', '--pool', 'open',
      '--handle', 'my-donor',
    ]);
    expect(withHandle.kind).toBe('share');
    if (withHandle.kind !== 'share') return;
    expect(withHandle.handle).toBe('my-donor');

    const without = parseArgs([
      'share', '--compute', '--idle', '22:00-07:00', '--cap', '1000', '--pool', 'open',
    ]);
    expect(without.kind).toBe('share');
    if (without.kind !== 'share') return;
    expect(typeof without.handle).toBe('string');
    expect(without.handle.length).toBeGreaterThan(0);
  });

  it('share arms the payment gate with --price (decimal) + --chain', () => {
    const priced = parseArgs([
      'share', '--compute', '--idle', '22:00-07:00', '--cap', '1000', '--pool', 'open',
      '--price', '0.001', '--chain', 'base',
    ]);
    expect(priced.kind).toBe('share');
    if (priced.kind !== 'share') return;
    expect(priced.config.priceUsdc).toBe(0.001);
    expect(priced.config.chain).toBe('base');

    const poly = parseArgs([
      'share', '--compute', '--idle=09:00-17:00', '--cap=1000', '--pool=open', '--price=1.5', '--chain=polygon',
    ]);
    expect(poly.kind).toBe('share');
    if (poly.kind !== 'share') return;
    expect(poly.config.priceUsdc).toBe(1.5);
    expect(poly.config.chain).toBe('polygon');
  });

  it('share stays FREE by default (priceUsdc 0) and rejects a bad chain/price', () => {
    const free = parseArgs(['share', '--compute', '--idle', '22:00-07:00', '--cap', '1000', '--pool', 'open']);
    expect(free.kind).toBe('share');
    if (free.kind !== 'share') return;
    expect(free.config.priceUsdc).toBe(0);

    expect(() =>
      parseArgs(['share', '--compute', '--idle', '22:00-07:00', '--cap', '1000', '--pool', 'open', '--chain', 'solana']),
    ).toThrow(/chain/);
    expect(() =>
      parseArgs(['share', '--compute', '--idle', '22:00-07:00', '--cap', '1000', '--pool', 'open', '--price', '0']),
    ).toThrow(/positive/);
  });
});

describe('parseArgs (request)', () => {
  it('parses the canonical request command (prompt + pool, default handle)', () => {
    const cmd = parseArgs(['request', 'reverse me', '--pool', 'allowlist:alice,bob']);
    expect(cmd).toEqual({
      kind: 'request',
      prompt: 'reverse me',
      pool: { kind: 'allowlist', peers: ['alice', 'bob'] },
      handle: 'consumer',
    });
  });

  it('accepts --handle and --timeout, and =-joined flags', () => {
    const cmd = parseArgs([
      'request', 'hello', '--pool=open', '--handle=alice', '--timeout=8000',
    ]);
    expect(cmd.kind).toBe('request');
    if (cmd.kind !== 'request') return;
    expect(cmd.pool).toEqual({ kind: 'open' });
    expect(cmd.handle).toBe('alice');
    expect(cmd.timeoutMs).toBe(8000);
  });

  it('accepts --pay <usdc> (x402) and surfaces a bad price', () => {
    const cmd = parseArgs(['request', 'hello', '--pool', 'open', '--pay', '0.001']);
    expect(cmd.kind).toBe('request');
    if (cmd.kind !== 'request') return;
    expect(cmd.payUsdc).toBe(0.001);

    const joined = parseArgs(['request', 'hello', '--pool=open', '--pay=1.5']);
    expect(joined.kind).toBe('request');
    if (joined.kind !== 'request') return;
    expect(joined.payUsdc).toBe(1.5);

    // --pay defaults to omitted (auto-read the donor's advertised price).
    const none = parseArgs(['request', 'hello', '--pool', 'open']);
    expect(none.kind).toBe('request');
    if (none.kind !== 'request') return;
    expect(none.payUsdc).toBeUndefined();

    expect(() => parseArgs(['request', 'hello', '--pool', 'open', '--pay', '0'])).toThrow(/positive/);
    expect(() => parseArgs(['request', 'hello', '--pool', 'open', '--pay', 'free'])).toThrow(/invalid price/);
  });

  it('requires a prompt and --pool', () => {
    expect(() => parseArgs(['request', '--pool', 'open'])).toThrow(/prompt/);
    expect(() => parseArgs(['request', 'hi'])).toThrow(/--pool/);
  });

  it('rejects a non-positive --timeout and unknown options', () => {
    expect(() =>
      parseArgs(['request', 'hi', '--pool', 'open', '--timeout', '0']),
    ).toThrow(/timeout/);
    expect(() =>
      parseArgs(['request', 'hi', '--pool', 'open', '--bogus']),
    ).toThrow(/unexpected option/);
    expect(() =>
      parseArgs(['request', 'hi', 'extra', '--pool', 'open']),
    ).toThrow(/unexpected argument/);
  });

  it('surfaces pool validation errors from parsePool', () => {
    expect(() => parseArgs(['request', 'hi', '--pool', 'nonsense:foo'])).toThrow();
  });
});
