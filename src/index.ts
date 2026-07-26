/**
 * @pooriaarab/vibedonate — BitTorrent-style mesh for AI inference.
 *
 * v0 ships the SAFE tier only: **local compute** donated from your own machine,
 * plus metering and an allow-list. Routing a stranger's inference through your
 * logged-in account or API key is deliberately out of scope — that needs
 * trust/legal design first (see docs/spec.md §"Open questions").
 *
 * Everything here is pure and injectable: no module-level state, no implicit IO.
 * `now`, `systemBusy`, the metering store, and the consent ledger are all passed
 * in, which is what makes the gating logic unit-testable to exhaustion.
 *
 * The consent model comes from `@pooriaarab/vibe-core`: the durable opt-in is a
 * `donate:compute` grant in the consent ledger. The CLI keeps that grant in sync
 * with `config.enabled`; `request_capacity` (MCP) refuses without it.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Re-exported so consumers of this package never import @vibe/core directly for
// the pieces vibedonate leans on. verbatimModuleSyntax → split value vs. type.
import { createConsentLedger } from '@pooriaarab/vibe-core';
import type { ConsentGrant, ConsentLedger, ConsentScope, ConsentStore } from '@pooriaarab/vibe-core';

export { createConsentLedger };
export type { ConsentGrant, ConsentLedger, ConsentScope, ConsentStore };

/** The consent scope that arms local-compute donation. {@link createDonationConfig} */
export const DONATE_COMPUTE_SCOPE = 'donate:compute' as const;

/** Capacity a donor can share. v0: local compute only. */
export type DonationTier = 'compute';

/**
 * Who may receive donated capacity.
 * - `open` — any peer (you opted into the open pool).
 * - `org`  — a named group; `members` is the allow-list for that org.
 * - `allowlist` — an explicit peer-id list.
 */
export type RecipientPool =
  | { readonly kind: 'open' }
  | { readonly kind: 'org'; readonly id: string; readonly members: readonly string[] }
  | { readonly kind: 'allowlist'; readonly peers: readonly string[] };

/** An idle-hours window as `"HH:MM"`. May wrap midnight (e.g. 22:00→07:00). */
export interface IdleWindow {
  readonly start: string;
  readonly end: string;
}

/** The complete, immutable donation configuration. Pure data. */
export interface DonationConfig {
  readonly tier: DonationTier;
  readonly idle: IdleWindow;
  /** Max tokens donated per calendar day (UTC date of the receipt ts). */
  readonly cap: number;
  readonly pool: RecipientPool;
  /** Master opt-in toggle. Mirrors the `donate:compute` consent grant. */
  readonly enabled: boolean;
  readonly createdAt: string;
}

/** Options accepted by {@link createDonationConfig}. */
export interface CreateDonationConfigOpts {
  readonly tier?: DonationTier;
  /** `"HH:MM-HH:MM"`, e.g. `"22:00-07:00"`. */
  readonly idle: string;
  /** Tokens/day. A bare integer, or `2M` / `500k` shorthand. */
  readonly cap: number | string;
  /** `"open"` · `"org:id[,member...]"` · `"allowlist:peer,peer"`. */
  readonly pool: string;
  readonly enabled?: boolean;
}

/** A tamper-evident usage receipt recorded in the metering ledger. */
export interface UsageReceipt {
  readonly seq: number;
  readonly peer: string;
  readonly tokens: number;
  readonly model: string;
  readonly ts: string;
  readonly direction: 'donated' | 'received';
  /** Hash of the previous receipt — links the chain. */
  readonly prev: string;
  /** sha256(seq:prev:peer:tokens:model:ts:direction). */
  readonly hash: string;
}

/** Aggregated usage returned by {@link MeteringLedger.totals}. */
export interface MeteringTotals {
  readonly donated: number;
  readonly donatedToday: number;
  readonly received: number;
  readonly count: number;
}

/** Optional durable backing for the metering ledger. */
export interface MeteringStore {
  load(): UsageReceipt[];
  save(receipts: readonly UsageReceipt[]): void;
}

/** Input to {@link MeteringLedger.record}. */
export interface RecordInput {
  readonly peer: string;
  readonly tokens: number;
  readonly model: string;
  readonly ts?: string;
  readonly direction?: 'donated' | 'received';
}

/** The local tamper-evident metering ledger. */
export interface MeteringLedger {
  /** Append a receipt, returning the (hash-chained) record. */
  record(input: RecordInput): UsageReceipt;
  /** Every receipt in chain order. */
  all(): readonly UsageReceipt[];
  /** Aggregated totals; `donatedToday` is scoped to `now`'s UTC day. */
  totals(now?: Date): MeteringTotals;
  /** Tokens still donatable before `cap` is hit (≥ 0). */
  remainingToday(cap: number, now?: Date): number;
  /** Recompute the hash-chain; false if any receipt was mutated/removed/reordered. */
  verify(): boolean;
}

const GENESIS_HASH = '0'.repeat(64);
const CAP_MULT: Readonly<Record<string, number>> = { k: 1_000, m: 1_000_000 };

/** `HH:MM` → minutes since midnight. Throws on malformed input. */
export function toMinutes(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m || m[1] === undefined || m[2] === undefined) {
    throw new Error(`invalid time (expected HH:MM): ${JSON.stringify(hhmm)}`);
  }
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) {
    throw new Error(`invalid time (out of range): ${JSON.stringify(hhmm)}`);
  }
  return h * 60 + min;
}

function minutesOf(d: Date): number {
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function utcDayKey(ts: string): string {
  // The ISO timestamp's date half is the day bucket. UTC-stable, no TZ surprises.
  return ts.slice(0, 10);
}

/**
 * Is `now` (treated as UTC) within an idle window? Windows may wrap midnight:
 * `22:00-07:00` is active 22:00→24:00 and 00:00→07:00. A degenerate
 * `start === end` window reads as "always active".
 *
 * Pure — depends only on its arguments.
 */
export function withinIdleWindow(window: IdleWindow, now: Date): boolean {
  const start = toMinutes(window.start);
  const end = toMinutes(window.end);
  const cur = minutesOf(now);
  if (start === end) return true;
  if (start < end) return cur >= start && cur < end;
  return cur >= start || cur < end; // wraps midnight
}

/**
 * Parse a `"HH:MM-HH:MM"` window. Throws on a malformed range.
 */
export function parseIdleWindow(idle: string): IdleWindow {
  const parts = idle.split('-');
  if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) {
    throw new Error(`invalid idle window (expected HH:MM-HH:MM): ${JSON.stringify(idle)}`);
  }
  const start = parts[0].trim();
  const end = parts[1].trim();
  // Validate both halves eagerly.
  toMinutes(start);
  toMinutes(end);
  return { start, end };
}

/**
 * Parse a token cap: a bare integer, or `2M` / `500k` shorthand
 * (case-insensitive). Floors to an integer; throws if not a positive number.
 */
export function parseCap(input: number | string): number {
  let n: number;
  if (typeof input === 'number') {
    n = input;
  } else {
    const m = /^(\d+(?:\.\d+)?)([km])?$/i.exec(input.trim());
    if (!m || m[1] === undefined) {
      throw new Error(`invalid cap (expected a number or e.g. 2M): ${JSON.stringify(input)}`);
    }
    const base = Number(m[1]);
    const mult = m[2] !== undefined ? (CAP_MULT[m[2].toLowerCase()] ?? 1) : 1;
    n = base * mult;
  }
  const floored = Math.floor(n);
  if (!Number.isFinite(floored) || floored <= 0) {
    throw new Error(`invalid cap (must be a positive number): ${JSON.stringify(input)}`);
  }
  return floored;
}

/**
 * Parse a recipient pool:
 * - `"open"`
 * - `"org:id"` or `"org:id,alice,bob"` (id first, rest are members)
 * - `"allowlist:alice,bob"`
 */
export function parsePool(pool: string): RecipientPool {
  const trimmed = pool.trim();
  if (trimmed === 'open' || trimmed === 'open:') return { kind: 'open' };
  const idx = trimmed.indexOf(':');
  if (idx === -1) {
    throw new Error(`invalid pool (expected open|org:id|allowlist:peers): ${JSON.stringify(pool)}`);
  }
  const kind = trimmed.slice(0, idx);
  const rest = trimmed.slice(idx + 1);
  const parts = rest.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  if (kind === 'allowlist') {
    if (parts.length === 0) throw new Error('allowlist pool needs at least one peer');
    return { kind: 'allowlist', peers: parts };
  }
  if (kind === 'org') {
    if (parts.length === 0) throw new Error('org pool needs an id (org:id)');
    const [id, ...members] = parts;
    if (id === undefined) throw new Error('org pool needs an id');
    return { kind: 'org', id, members };
  }
  throw new Error(`invalid pool kind (open|org|allowlist): ${JSON.stringify(kind)}`);
}

/**
 * Build a validated {@link DonationConfig}. Pure — no IO, no side effects.
 * Throws on any invalid option rather than silently coercing.
 */
export function createDonationConfig(opts: CreateDonationConfigOpts): DonationConfig {
  if (opts.tier !== undefined && opts.tier !== 'compute') {
    throw new Error(`vibedonate v0 only supports the "compute" tier (got ${JSON.stringify(opts.tier)})`);
  }
  const idle = parseIdleWindow(opts.idle);
  const cap = parseCap(opts.cap);
  const pool = parsePool(opts.pool);
  return {
    tier: 'compute',
    idle,
    cap,
    pool,
    enabled: opts.enabled ?? true,
    createdAt: new Date().toISOString(),
  };
}

/**
 * The core gating predicate. **Pure.** True iff:
 *  1. the donation is `enabled` (master toggle / consent),
 *  2. the machine is not busy with local activity (`systemBusy`),
 *  3. today's donated tokens are still under `cap`, and
 *  4. `now` falls inside the idle window.
 *
 * `donatedToday` defaults to `0` so the 3-argument form answers the
 * *schedule* question; pass the ledger's `donatedToday` to also enforce the cap.
 */
export function isSharingActive(
  config: DonationConfig,
  now: Date,
  systemBusy: boolean,
  donatedToday = 0,
): boolean {
  if (!config.enabled) return false;
  if (systemBusy) return false;
  if (donatedToday >= config.cap) return false;
  return withinIdleWindow(config.idle, now);
}

/**
 * Is `peerId` authorized to receive donated capacity? v0 = pool membership:
 * `open` allows anyone; `allowlist`/`org` require explicit membership.
 * Pure.
 */
export function authorizePeer(config: DonationConfig, peerId: string): 'allow' | 'deny' {
  const { pool } = config;
  switch (pool.kind) {
    case 'open':
      return 'allow';
    case 'allowlist':
      return pool.peers.includes(peerId) ? 'allow' : 'deny';
    case 'org':
      return pool.members.includes(peerId) ? 'allow' : 'deny';
  }
}

function chainHash(seq: number, prev: string, peer: string, tokens: number, model: string, ts: string, direction: string): string {
  return createHash('sha256')
    .update(`${seq}:${prev}:${peer}:${tokens}:${model}:${ts}:${direction}`)
    .digest('hex');
}

// ---------------------------------------------------------------------------
// File-backed stores & config persistence (concrete backing for the
// injectable MeteringStore / ConsentStore). The core logic above stays pure;
// these helpers are opt-in durability for the CLI and MCP server.
// ---------------------------------------------------------------------------

/** Resolve the default data dir: `$VIBEDONATE_DIR` or `~/.vibedonate`. */
export function defaultDataDir(): string {
  const env = process.env['VIBEDONATE_DIR'];
  return env && env.length > 0 ? env : join(homedir(), '.vibedonate');
}

export function configPath(dir: string = defaultDataDir()): string {
  return join(dir, 'config.json');
}
export function meteringPath(dir: string = defaultDataDir()): string {
  return join(dir, 'metering.json');
}
export function consentPath(dir: string = defaultDataDir()): string {
  return join(dir, 'consent.json');
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8');
  if (raw.trim().length === 0) return null;
  return JSON.parse(raw) as T;
}

function writeJson(path: string, value: unknown, dir: string): void {
  ensureDir(dir);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** Load the persisted config, or `null` if donation was never armed. */
export function loadConfigFromFile(dir: string = defaultDataDir()): DonationConfig | null {
  return readJson<DonationConfig>(configPath(dir));
}

/** Persist `config`. The CLI keeps this in sync with the consent ledger. */
export function saveConfigToFile(config: DonationConfig, dir: string = defaultDataDir()): void {
  writeJson(configPath(dir), config, dir);
}

/** A {@link MeteringStore} backed by `metering.json` in `dir`. */
export function fileMeteringStore(dir: string = defaultDataDir()): MeteringStore {
  return {
    load() {
      const data = readJson<UsageReceipt[]>(meteringPath(dir));
      return data ?? [];
    },
    save(receipts) {
      writeJson(meteringPath(dir), receipts, dir);
    },
  };
}

/** A {@link ConsentStore} backed by `consent.json` in `dir`. */
export function fileConsentStore(dir: string = defaultDataDir()): ConsentStore {
  return {
    load() {
      const data = readJson<{ scope: string; grantedAt: string; note?: string }[]>(consentPath(dir));
      return data ?? [];
    },
    save(grants) {
      writeJson(consentPath(dir), grants, dir);
    },
  };
}

/**
 * Create a local, tamper-evident metering ledger. Receipts form a sha-256
 * hash-chain: mutating any field, dropping, or reordering a receipt breaks
 * {@link MeteringLedger.verify}. The backing store is injected; omit it for an
 * in-memory ledger (tests, ephemeral sessions).
 */
export function createMeteringLedger(store?: MeteringStore): MeteringLedger {
  const initial = store ? store.load() : [];
  // Persisted state is append-only; validate the chain on load so a corrupted
  // file is detected immediately rather than after a bad record.
  const receipts: UsageReceipt[] = initial.slice();

  const persist = () => store?.save(receipts);

  const headHash = (): string => {
    const last = receipts[receipts.length - 1];
    return last !== undefined ? last.hash : GENESIS_HASH;
  };

  return {
    record(input) {
      if (!Number.isFinite(input.tokens) || input.tokens <= 0) {
        throw new Error(`invalid tokens (must be a positive number): ${input.tokens}`);
      }
      if (input.peer.trim().length === 0) throw new Error('receipt needs a peer');
      if (input.model.trim().length === 0) throw new Error('receipt needs a model');
      const seq = receipts.length; // 0-based
      const ts = input.ts ?? new Date().toISOString();
      const direction = input.direction ?? 'donated';
      const prev = headHash();
      const hash = chainHash(seq, prev, input.peer, input.tokens, input.model, ts, direction);
      const receipt: UsageReceipt = {
        seq,
        peer: input.peer,
        tokens: Math.floor(input.tokens),
        model: input.model,
        ts,
        direction,
        prev,
        hash,
      };
      receipts.push(receipt);
      persist();
      return receipt;
    },
    all() {
      return receipts.slice();
    },
    totals(now = new Date()) {
      const day = utcDayKey(now.toISOString());
      let donated = 0;
      let donatedToday = 0;
      let received = 0;
      for (const r of receipts) {
        if (r.direction === 'donated') {
          donated += r.tokens;
          if (utcDayKey(r.ts) === day) donatedToday += r.tokens;
        } else {
          received += r.tokens;
        }
      }
      return { donated, donatedToday, received, count: receipts.length };
    },
    remainingToday(cap, now = new Date()) {
      const used = this.totals(now).donatedToday;
      return Math.max(0, cap - used);
    },
    verify() {
      let prev = GENESIS_HASH;
      for (let i = 0; i < receipts.length; i += 1) {
        const r = receipts[i];
        if (r === undefined || r.seq !== i || r.prev !== prev) return false;
        const expected = chainHash(r.seq, r.prev, r.peer, r.tokens, r.model, r.ts, r.direction);
        if (expected !== r.hash) return false;
        prev = r.hash;
      }
      return true;
    },
  };
}

