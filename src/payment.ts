/**
 * @pooriaarab/vibedonate — OPTIONAL x402 / USDC charge-per-inference layer.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type Chain = 'base' | 'ethereum' | 'polygon';

export interface PaymentTerms {
  readonly priceUsdc: number;
  readonly chain: Chain;
  readonly payTo: string;
}

export interface PaymentProof {
  readonly payer: string;
  readonly amountUsdc: number;
  readonly txRef: string;
  readonly sig?: string;
}

export interface ChargeResult {
  readonly paid: boolean;
  readonly txRef?: string;
}

export interface Wallet {
  address(): string;
  charge(payer: string, amountUsdc: number, memo?: string): Promise<ChargeResult>;
  verify(proof: PaymentProof): Promise<boolean>;
}

export function stubWallet(seed = 'vibedonate-stub'): Wallet {
  const addr = `0x${shortHash(`addr:${seed}`, 40)}`;
  const intents: PaymentProof[] = [];
  return {
    address(): string { return addr; },
    async charge(payer: string, amountUsdc: number, memo?: string): Promise<ChargeResult> {
      if (!isWellFormedPayer(payer) || !isPositiveAmount(amountUsdc)) return { paid: false };
      const txRef = stubTxRef(payer, amountUsdc);
      intents.push({ payer, amountUsdc, txRef });
      void memo;
      return { paid: true, txRef };
    },
    async verify(proof: PaymentProof): Promise<boolean> {
      if (!isWellFormedPayer(proof.payer) || !isPositiveAmount(proof.amountUsdc)) return false;
      if (typeof proof.txRef !== 'string' || proof.txRef.length === 0) return false;
      return proof.txRef === stubTxRef(proof.payer, proof.amountUsdc);
    },
  };
}

export function stubTxRef(payer: string, amountUsdc: number): string {
  return `stub:${shortHash(`${payer}:${amountUsdc}`, 16)}`;
}

function isWellFormedPayer(payer: string): boolean {
  return typeof payer === 'string' && payer.trim().length > 0;
}

function isPositiveAmount(amountUsdc: number): boolean {
  return typeof amountUsdc === 'number' && Number.isFinite(amountUsdc) && amountUsdc > 0;
}

function shortHash(input: string, hexChars: number): string {
  return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, hexChars);
}

export type PaymentDirection = 'received' | 'sent';

export interface PaymentRecordInput {
  readonly peer: string;
  readonly amountUsdc: number;
  readonly direction: PaymentDirection;
  readonly txRef: string;
  readonly ts?: string;
}

export interface PaymentRecord {
  readonly seq: number;
  readonly peer: string;
  readonly amountUsdc: number;
  readonly direction: PaymentDirection;
  readonly txRef: string;
  readonly ts: string;
  readonly prev: string;
  readonly hash: string;
}

export interface PaymentTotals {
  readonly received: number;
  readonly sent: number;
  readonly count: number;
}

export interface PaymentStore {
  load(): PaymentRecord[];
  save(records: readonly PaymentRecord[]): void;
}

export interface PaymentLedger {
  record(input: PaymentRecordInput): PaymentRecord;
  all(): readonly PaymentRecord[];
  totals(): PaymentTotals;
  verify(): boolean;
}

const PAYMENT_GENESIS_HASH = '0'.repeat(64);

interface PaymentHashInput {
  readonly seq: number;
  readonly prev: string;
  readonly peer: string;
  readonly amount: number;
  readonly direction: string;
  readonly txRef: string;
  readonly ts: string;
}

function paymentChainHash(input: PaymentHashInput): string {
  return createHash('sha256')
    .update(`${input.seq}:${input.prev}:${input.peer}:${input.amount}:${input.direction}:${input.txRef}:${input.ts}`)
    .digest('hex');
}

function validatePaymentInput(input: PaymentRecordInput): void {
  if (!isWellFormedPayer(input.peer)) throw new Error('payment record needs a peer');
  if (!isPositiveAmount(input.amountUsdc)) throw new Error(`invalid amount (must be a positive number): ${input.amountUsdc}`);
  if (typeof input.txRef !== 'string' || input.txRef.trim().length === 0) throw new Error('payment record needs a txRef');
}

function buildPaymentRecord(seq: number, prev: string, input: PaymentRecordInput, ts: string): PaymentRecord {
  const hash = paymentChainHash({ seq, prev, peer: input.peer, amount: input.amountUsdc, direction: input.direction, txRef: input.txRef, ts });
  return { seq, peer: input.peer, amountUsdc: input.amountUsdc, direction: input.direction, txRef: input.txRef, ts, prev, hash };
}

function computePaymentTotals(records: readonly PaymentRecord[]): PaymentTotals {
  let received = 0;
  let sent = 0;
  for (const r of records) {
    if (r.direction === 'received') received += r.amountUsdc;
    else sent += r.amountUsdc;
  }
  return { received, sent, count: records.length };
}

function verifyPaymentChain(records: readonly PaymentRecord[]): boolean {
  let prev = PAYMENT_GENESIS_HASH;
  for (let i = 0; i < records.length; i += 1) {
    const r = records[i];
    if (r === undefined || r.seq !== i || r.prev !== prev) return false;
    const expected = paymentChainHash({ seq: r.seq, prev: r.prev, peer: r.peer, amount: r.amountUsdc, direction: r.direction, txRef: r.txRef, ts: r.ts });
    if (expected !== r.hash) return false;
    prev = r.hash;
  }
  return true;
}

export function createPaymentLedger(store?: PaymentStore): PaymentLedger {
  const records: PaymentRecord[] = store ? store.load().slice() : [];
  const persist = (): void => { store?.save(records); };
  const headHash = (): string => {
    const last = records[records.length - 1];
    return last !== undefined ? last.hash : PAYMENT_GENESIS_HASH;
  };
  return {
    record(input) {
      validatePaymentInput(input);
      const seq = records.length;
      const ts = input.ts ?? new Date().toISOString();
      const prev = headHash();
      const rec = buildPaymentRecord(seq, prev, input, ts);
      records.push(rec);
      persist();
      return rec;
    },
    all() { return records.slice(); },
    totals() { return computePaymentTotals(records); },
    verify() { return verifyPaymentChain(records); },
  };
}

export function parsePriceUsdc(input: number | string): number {
  let n: number;
  if (typeof input === 'number') n = input;
  else {
    const trimmed = input.trim();
    if (!/^\d+(?:\.\d+)?$/.test(trimmed)) throw new Error(`invalid price (expected a USDC amount, e.g. 0.001): ${JSON.stringify(input)}`);
    n = Number(trimmed);
  }
  if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid price (must be a positive USDC amount): ${JSON.stringify(input)}`);
  return n;
}

export function paymentsPath(dir: string = defaultPaymentDir()): string {
  return join(dir, 'payments.json');
}

export function filePaymentStore(dir: string): PaymentStore {
  return {
    load(): PaymentRecord[] {
      const path = paymentsPath(dir);
      if (!existsSync(path)) return [];
      const raw = readFileSync(path, 'utf8');
      if (raw.trim().length === 0) return [];
      return JSON.parse(raw) as PaymentRecord[];
    },
    save(records: readonly PaymentRecord[]): void {
      const path = paymentsPath(dir);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
    },
  };
}

export function defaultPaymentDir(): string {
  const env = process.env['VIBEDONATE_DIR'];
  return env && env.length > 0 ? env : join(homedir(), '.vibedonate');
}
