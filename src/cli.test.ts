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
});
