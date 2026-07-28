/**
 * Unit tests for the x402 payment primitives: the stub wallet (deterministic
 * settlement + cross-instance verification) and the hash-chained payment ledger.
 * Mesh-level gating (denied without payment, allowed with proof) lives in
 * mesh.test.ts / mesh.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';

import {
  createPaymentLedger,
  parsePriceUsdc,
  stubTxRef,
  stubWallet,
} from './payment.js';

describe('stubWallet', () => {
  it('exposes a stable 20-byte-hex address derived from the seed', () => {
    const w = stubWallet('donor-1');
    expect(w.address()).toMatch(/^0x[0-9a-f]{40}$/);
    // Same seed → same address (reproducible across runs).
    expect(stubWallet('donor-1').address()).toBe(w.address());
    // Different seed → different address.
    expect(stubWallet('donor-2').address()).not.toBe(w.address());
  });

  it('charge() deterministically settles: always paid, txRef = stub:<…>, no network', async () => {
    const w = stubWallet();
    const r = await w.charge('alice', 0.5, 'job-1');
    expect(r.paid).toBe(true);
    expect(r.txRef).toBe(stubTxRef('alice', 0.5));
    expect(r.txRef?.startsWith('stub:')).toBe(true);
  });

  it('charge() is deterministic — same payer+amount → same txRef (memo ignored)', async () => {
    const w = stubWallet();
    const a = await w.charge('alice', 0.5, 'memo-one');
    const b = await w.charge('alice', 0.5, 'memo-two');
    expect(a.txRef).toBe(b.txRef);
  });

  it('charge() refuses a non-positive amount or empty payer', async () => {
    const w = stubWallet();
    expect((await w.charge('alice', 0)).paid).toBe(false);
    expect((await w.charge('alice', -1)).paid).toBe(false);
    expect((await w.charge('', 0.5)).paid).toBe(false);
  });

  it('verify() accepts a real proof minted by a SEPARATE stubWallet (cross-instance)', async () => {
    const consumer = stubWallet('consumer-seed');
    const donor = stubWallet('donor-seed'); // different instance + seed
    const { txRef } = await consumer.charge('alice', 0.25);
    const proof = { payer: 'alice', amountUsdc: 0.25, txRef: txRef! };
    // The donor validates without sharing state with the consumer's wallet.
    await expect(donor.verify(proof)).resolves.toBe(true);
  });

  it('verify() rejects a forged / malformed proof', async () => {
    const donor = stubWallet();
    await expect(donor.verify({ payer: 'alice', amountUsdc: 0.25, txRef: 'bogus' })).resolves.toBe(false);
    await expect(donor.verify({ payer: 'alice', amountUsdc: 0.25, txRef: '' })).resolves.toBe(false);
    await expect(donor.verify({ payer: '', amountUsdc: 0.25, txRef: stubTxRef('alice', 0.25) })).resolves.toBe(false);
    await expect(donor.verify({ payer: 'alice', amountUsdc: 0, txRef: stubTxRef('alice', 0) })).resolves.toBe(false);
    // A txRef recomputed for a DIFFERENT amount does not verify for this amount.
    await expect(
      donor.verify({ payer: 'alice', amountUsdc: 0.25, txRef: stubTxRef('alice', 0.99) }),
    ).resolves.toBe(false);
  });
});

describe('parsePriceUsdc', () => {
  it('accepts decimals and integers', () => {
    expect(parsePriceUsdc(0.001)).toBe(0.001);
    expect(parsePriceUsdc('1.5')).toBe(1.5);
    expect(parsePriceUsdc('10')).toBe(10);
  });

  it('rejects non-positive, non-numeric, and shorthand-with-suffix input', () => {
    expect(() => parsePriceUsdc(0)).toThrow(/positive/);
    expect(() => parsePriceUsdc(-1)).toThrow(/positive/);
    expect(() => parsePriceUsdc('free')).toThrow(/invalid price/);
    expect(() => parsePriceUsdc('2M')).toThrow(/invalid price/); // no k/M shorthand for prices
  });
});

describe('createPaymentLedger (hash-chained, mirrors MeteringLedger)', () => {
  it('records append-only hash-chained entries and aggregates totals', () => {
    const ledger = createPaymentLedger();
    const r1 = ledger.record({ peer: 'alice', amountUsdc: 0.5, direction: 'received', txRef: 'stub:a' });
    const r2 = ledger.record({ peer: 'bob', amountUsdc: 0.25, direction: 'sent', txRef: 'stub:b' });
    expect(r1.seq).toBe(0);
    expect(r1.prev).toBe('0'.repeat(64));
    expect(r2.seq).toBe(1);
    expect(r2.prev).toBe(r1.hash);
    expect(ledger.all()).toHaveLength(2);
    expect(ledger.totals()).toEqual({ received: 0.5, sent: 0.25, count: 2 });
  });

  it('verify() is true on an intact chain, false when a record is tampered', () => {
    const ledger = createPaymentLedger();
    const r1 = ledger.record({ peer: 'alice', amountUsdc: 0.5, direction: 'received', txRef: 'stub:a' });
    ledger.record({ peer: 'bob', amountUsdc: 0.25, direction: 'received', txRef: 'stub:b' });
    expect(ledger.verify()).toBe(true);
    // Tamper the first record's amount in place: the stored hash was computed
    // over 0.5, so the chain no longer links and verify() must fail.
    (r1 as { amountUsdc: number }).amountUsdc = 999;
    expect(ledger.verify()).toBe(false);
  });

  it('record() rejects an invalid amount / empty peer / empty txRef', () => {
    const ledger = createPaymentLedger();
    expect(() => ledger.record({ peer: 'alice', amountUsdc: 0, direction: 'received', txRef: 'x' })).toThrow(/amount/);
    expect(() => ledger.record({ peer: '', amountUsdc: 1, direction: 'received', txRef: 'x' })).toThrow(/peer/);
    expect(() => ledger.record({ peer: 'alice', amountUsdc: 1, direction: 'received', txRef: '' })).toThrow(/txRef/);
  });
});
