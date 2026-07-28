/**
 * @pooriaarab/vibedonate — OPTIONAL x402 / USDC charge-per-inference layer.
 *
 * x402 is the open "HTTP 402 Payment Required" standard for machine payments:
 * a server returns 402 with payment terms, the client pays (USDC on
 * Base/Ethereum/Polygon), and retries with a proof of payment. vibedonate is
 * FREE by default — this module adds an OPTIONAL payment gate so a donor CAN
 * charge per job. Free jobs (price 0) take the unchanged path and never touch
 * this module's runtime types.
 *
 * v0 deliberately does NOT do real on-chain settlement. What ships here is:
 *   1. the GATE — a donor with price > 0 refuses to run a job that arrives
 *      without a verifiable {@link PaymentProof}; and
 *   2. a pluggable {@link Wallet} interface — exactly the seam a real USDC
 *      wallet drops into. {@link stubWallet} is the deterministic, network-free
 *      placeholder (mirrors how `src/mesh.ts` ships an echo model stub while
 *      the real local runner lands later).
 *
 * A real wallet implements {@link Wallet}: `address()` returns the on-chain
 * receiving address, `charge()` submits a real USDC transfer and returns the
 * chain tx hash as `txRef`, and `verify()` confirms the transfer settled on
 * chain. The gate, the wire frames, the ledger, and the CLI are unchanged.
 *
 * Privacy is preserved exactly like the rest of the mesh: the handshake
 * advertises only the price + receiving address ({@link PaymentTerms}), and a
 * job carries only a {@link PaymentProof} — never raw usage. No new usage data
 * touches the wire because of this layer.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ===========================================================================
// Terms + proof (the only things that touch the wire).
// ===========================================================================

/** Settlement chain for USDC. Matches x402's supported networks. */
export type Chain = 'base' | 'ethereum' | 'polygon';

/**
 * What a priced donor charges per job. Advertised in the donor's hello handshake
 * (priceUsdc + chain + payTo) so a consumer knows what to pay. Contains NO usage
 * data — only the price and where to send it.
 */
export interface PaymentTerms {
  /** Price per job in USDC. > 0 (price 0 = FREE never builds PaymentTerms). */
  readonly priceUsdc: number;
  readonly chain: Chain;
  /** On-chain receiving address (the donor's wallet address). */
  readonly payTo: string;
}

/**
 * A consumer's proof that it paid for a job. Attached to the `job` frame when
 * the donor is priced. The donor's wallet {@link Wallet.verify | verifies} this
 * before any work runs. Carries no usage — only payer, amount, txRef, optional
 * signature.
 */
export interface PaymentProof {
  /** Payer handle (the consumer's mesh identity — matches its hello). */
  readonly payer: string;
  readonly amountUsdc: number;
  /** Settlement reference: on-chain tx hash (real) or `stub:…` (stub). */
  readonly txRef: string;
  /** Optional cryptographic signature over the proof (real wallets). */
  readonly sig?: string;
}

/** Result of {@link Wallet.charge}. */
export interface ChargeResult {
  readonly paid: boolean;
  /** Present when `paid` — the settlement reference to put on the proof. */
  readonly txRef?: string;
}

// ===========================================================================
// Wallet — the pluggable settlement seam.
// ===========================================================================

/**
 * The settlement interface. v0 ships only {@link stubWallet}; a real USDC wallet
 * (Coinbase x402 facilitator, direct RPC, etc.) implements this and drops in
 * without touching the gate, frames, or ledger.
 *
 * Contract:
 *  - `address()` — the donor's on-chain receiving address (goes on
 *    {@link PaymentTerms.payTo}). Pure, synchronous, stable.
 *  - `charge(payer, amountUsdc, memo)` — the CONSUMER side: submit a USDC
 *    payment of `amountUsdc` from the payer to this wallet's address. Records
 *    the intent and resolves `{ paid, txRef }`. `paid:false` means settlement
 *    failed (insufficient balance, rejected, etc.).
 *  - `verify(proof)` — the DONOR side: confirm a proof represents a real settled
 *    payment of `amountUsdc` from `payer`. Resolves `true` iff the payment is
 *    final and can be trusted to release the job.
 *
 * Both sides are async because real settlement is async (block confirmations,
 * facilitator round-trips). The stub resolves immediately.
 */
export interface Wallet {
  address(): string;
  charge(payer: string, amountUsdc: number, memo?: string): Promise<ChargeResult>;
  verify(proof: PaymentProof): Promise<boolean>;
}

// ===========================================================================
// stubWallet — deterministic, network-free v0 placeholder.
// ===========================================================================

/**
 * Build a deterministic, network-free {@link Wallet}. Mirrors the echo-model stub
 * in `src/mesh.ts`: it is obviously a placeholder, trivially assertable, and the
 * exact shape a real wallet will satisfy.
 *
 * - `address()` — a stable 20-byte-hex address derived from `seed`
 *   (`0x<sha256('addr:'+seed)[:40]>`), so the same seed reproduces the same
 *   address across runs (lets the donor's advertised `payTo` match the wallet
 *   the CLI shows in `vibedonate wallet`).
 * - `charge()` — records the intent in-memory and ALWAYS resolves
 *   `{ paid:true, txRef:'stub:<…>' }`. No chain, no network.
 * - `verify()` — accepts a proof iff it is well-formed AND its `txRef` equals
 *   the deterministic value recomputed from `(payer, amountUsdc)`. The recompute
 *   is seed/memo-independent, so a donor's stubWallet validates a proof a
 *   consumer's stubWallet minted without sharing state. (A real wallet verifies
 *   an on-chain signature instead — the stub is intentionally forgeable and
 *   exists only to exercise the gate end-to-end.)
 */
export function stubWallet(seed = 'vibedonate-stub'): Wallet {
  const addr = `0x${shortHash(`addr:${seed}`, 40)}`;
  const intents: PaymentProof[] = [];

  return {
    address(): string {
      return addr;
    },
    async charge(payer: string, amountUsdc: number, memo?: string): Promise<ChargeResult> {
      if (!isWellFormedPayer(payer) || !isPositiveAmount(amountUsdc)) {
        return { paid: false };
      }
      const txRef = stubTxRef(payer, amountUsdc);
      // Records the settlement intent — in-memory only (durable audit trail is
      // the separate {@link createPaymentLedger}).
      intents.push({ payer, amountUsdc, txRef });
      void memo; // memo is accepted for API parity with real wallets; not hashed.
      return { paid: true, txRef };
    },
    async verify(proof: PaymentProof): Promise<boolean> {
      if (!isWellFormedPayer(proof.payer) || !isPositiveAmount(proof.amountUsdc)) {
        return false;
      }
      if (typeof proof.txRef !== 'string' || proof.txRef.length === 0) return false;
      // Deterministic recompute — seed-independent so the donor's separate
      // stubWallet can validate the consumer's proof without shared state.
      return proof.txRef === stubTxRef(proof.payer, proof.amountUsdc);
    },
  };
}

/** Deterministic stub settlement reference: `stub:<sha256(payer:amount)[:16]>`. */
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

// ===========================================================================
// Payment ledger — durable, hash-chained audit trail (mirrors MeteringLedger).
// ===========================================================================

/** Direction of a payment relative to the node recording it. */
export type PaymentDirection = 'received' | 'sent';

/** Input to {@link PaymentLedger.record}. */
export interface PaymentRecordInput {
  /** Counterparty handle (payer for a `received` record, payee for a `sent`). */
  readonly peer: string;
  readonly amountUsdc: number;
  readonly direction: PaymentDirection;
  readonly txRef: string;
  readonly ts?: string;
}

/** A tamper-evident payment receipt recorded in the payment ledger. */
export interface PaymentRecord {
  readonly seq: number;
  readonly peer: string;
  readonly amountUsdc: number;
  readonly direction: PaymentDirection;
  readonly txRef: string;
  readonly ts: string;
  /** Hash of the previous record — links the chain. */
  readonly prev: string;
  /** sha256(seq:prev:peer:amount:direction:txRef:ts). */
  readonly hash: string;
}

/** Aggregated payments returned by {@link PaymentLedger.totals}. */
export interface PaymentTotals {
  readonly received: number;
  readonly sent: number;
  readonly count: number;
}

/** Optional durable backing for the payment ledger. */
export interface PaymentStore {
  load(): PaymentRecord[];
  save(records: readonly PaymentRecord[]): void;
}

/** The local tamper-evident payment ledger. */
export interface PaymentLedger {
  /** Append a record, returning the (hash-chained) entry. */
  record(input: PaymentRecordInput): PaymentRecord;
  /** Every record in chain order. */
  all(): readonly PaymentRecord[];
  /** Aggregated totals. */
  totals(): PaymentTotals;
  /** Recompute the hash-chain; false if any record was mutated/removed/reordered. */
  verify(): boolean;
}

const PAYMENT_GENESIS_HASH = '0'.repeat(64);

function paymentChainHash(
  seq: number,
  prev: string,
  peer: string,
  amount: number,
  direction: string,
  txRef: string,
  ts: string,
): string {
  return createHash('sha256')
    .update(`${seq}:${prev}:${peer}:${amount}:${direction}:${txRef}:${ts}`)
    .digest('hex');
}

/**
 * Create a local, tamper-evident payment ledger. Records form a sha-256
 * hash-chain, exactly like {@link createMeteringLedger} in `src/index.ts`:
 * mutating any field, dropping, or reordering a record breaks {@link
 * PaymentLedger.verify}. The backing store is injected; omit it for an
 * in-memory ledger (tests, ephemeral sessions).
 */
export function createPaymentLedger(store?: PaymentStore): PaymentLedger {
  const initial = store ? store.load() : [];
  const records: PaymentRecord[] = initial.slice();

  const persist = (): void => {
    store?.save(records);
  };

  const headHash = (): string => {
    const last = records[records.length - 1];
    return last !== undefined ? last.hash : PAYMENT_GENESIS_HASH;
  };

  return {
    record(input) {
      if (!isWellFormedPayer(input.peer)) throw new Error('payment record needs a peer');
      if (!isPositiveAmount(input.amountUsdc)) {
        throw new Error(`invalid amount (must be a positive number): ${input.amountUsdc}`);
      }
      if (typeof input.txRef !== 'string' || input.txRef.trim().length === 0) {
        throw new Error('payment record needs a txRef');
      }
      const seq = records.length; // 0-based
      const ts = input.ts ?? new Date().toISOString();
      const direction = input.direction;
      const prev = headHash();
      const hash = paymentChainHash(seq, prev, input.peer, input.amountUsdc, direction, input.txRef, ts);
      const rec: PaymentRecord = {
        seq,
        peer: input.peer,
        amountUsdc: input.amountUsdc,
        direction,
        txRef: input.txRef,
        ts,
        prev,
        hash,
      };
      records.push(rec);
      persist();
      return rec;
    },
    all() {
      return records.slice();
    },
    totals() {
      let received = 0;
      let sent = 0;
      for (const r of records) {
        if (r.direction === 'received') received += r.amountUsdc;
        else sent += r.amountUsdc;
      }
      return { received, sent, count: records.length };
    },
    verify() {
      let prev = PAYMENT_GENESIS_HASH;
      for (let i = 0; i < records.length; i += 1) {
        const r = records[i];
        if (r === undefined || r.seq !== i || r.prev !== prev) return false;
        const expected = paymentChainHash(r.seq, r.prev, r.peer, r.amountUsdc, r.direction, r.txRef, r.ts);
        if (expected !== r.hash) return false;
        prev = r.hash;
      }
      return true;
    },
  };
}

// ===========================================================================
// Price parsing + file-backed store (concrete durability for the CLI).
// ===========================================================================

/**
 * Parse a USDC price. Accepts decimals (e.g. `0.001`, `1.5`) or integer USDC.
 * Throws if not a positive finite number — price 0 (FREE) never reaches here;
 * callers build {@link PaymentTerms} only when `price > 0`.
 */
export function parsePriceUsdc(input: number | string): number {
  let n: number;
  if (typeof input === 'number') {
    n = input;
  } else {
    const trimmed = input.trim();
    if (!/^\d+(?:\.\d+)?$/.test(trimmed)) {
      throw new Error(`invalid price (expected a USDC amount, e.g. 0.001): ${JSON.stringify(input)}`);
    }
    n = Number(trimmed);
  }
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`invalid price (must be a positive USDC amount): ${JSON.stringify(input)}`);
  }
  return n;
}

/** Resolve the payment-ledger file path under `dir`. */
export function paymentsPath(dir: string = defaultPaymentDir()): string {
  return join(dir, 'payments.json');
}

/** A {@link PaymentStore} backed by `payments.json` in `dir`. */
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

/** Default data dir helper — kept local so payment.ts has no src/index dependency. */
export function defaultPaymentDir(): string {
  const env = process.env['VIBEDONATE_DIR'];
  return env && env.length > 0 ? env : join(homedir(), '.vibedonate');
}
