import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface UsageReceipt {
  readonly seq: number;
  readonly peer: string;
  readonly tokens: number;
  readonly model: string;
  readonly ts: string;
  readonly direction: 'donated' | 'received';
  readonly prev: string;
  readonly hash: string;
}
export interface MeteringTotals {
  readonly donated: number;
  readonly donatedToday: number;
  readonly received: number;
  readonly count: number;
}
export interface MeteringStore {
  load(): UsageReceipt[];
  save(receipts: readonly UsageReceipt[]): void;
}
export interface RecordInput {
  readonly peer: string;
  readonly tokens: number;
  readonly model: string;
  readonly ts?: string;
  readonly direction?: 'donated' | 'received';
}
export interface MeteringLedger {
  record(input: RecordInput): UsageReceipt;
  all(): readonly UsageReceipt[];
  totals(now?: Date): MeteringTotals;
  remainingToday(cap: number, now?: Date): number;
  verify(): boolean;
}

const GENESIS_HASH = '0'.repeat(64);

interface ChainHashInput {
  readonly seq: number;
  readonly prev: string;
  readonly peer: string;
  readonly tokens: number;
  readonly model: string;
  readonly ts: string;
  readonly direction: string;
}

function chainHash(input: ChainHashInput): string {
  return createHash('sha256')
    .update(`${input.seq}:${input.prev}:${input.peer}:${input.tokens}:${input.model}:${input.ts}:${input.direction}`)
    .digest('hex');
}

function utcDayKey(ts: string): string { return ts.slice(0, 10); }

function validateRecordInput(input: RecordInput): void {
  if (!Number.isFinite(input.tokens) || input.tokens <= 0) throw new Error(`invalid tokens (must be a positive number): ${input.tokens}`);
  if (input.peer.trim().length === 0) throw new Error('receipt needs a peer');
  if (input.model.trim().length === 0) throw new Error('receipt needs a model');
}

interface BuildReceiptOpts { readonly seq: number; readonly prev: string; readonly input: RecordInput; readonly ts: string; readonly direction: 'donated' | 'received'; }
function buildReceipt(opts: BuildReceiptOpts): UsageReceipt {
  const { seq, prev, input, ts, direction } = opts;
  const hash = chainHash({ seq, prev, peer: input.peer, tokens: Math.floor(input.tokens), model: input.model, ts, direction });
  return { seq, peer: input.peer, tokens: Math.floor(input.tokens), model: input.model, ts, direction, prev, hash };
}

function computeTotals(receipts: readonly UsageReceipt[], now: Date): MeteringTotals {
  const day = utcDayKey(now.toISOString());
  let donated = 0; let donatedToday = 0; let received = 0;
  for (const r of receipts) {
    if (r.direction === 'donated') {
      donated += r.tokens;
      if (utcDayKey(r.ts) === day) donatedToday += r.tokens;
    } else received += r.tokens;
  }
  return { donated, donatedToday, received, count: receipts.length };
}

function verifyChain(receipts: readonly UsageReceipt[]): boolean {
  let prev = GENESIS_HASH;
  for (let i = 0; i < receipts.length; i += 1) {
    const r = receipts[i];
    if (r === undefined || r.seq !== i || r.prev !== prev) return false;
    const expected = chainHash({ seq: r.seq, prev: r.prev, peer: r.peer, tokens: r.tokens, model: r.model, ts: r.ts, direction: r.direction });
    if (expected !== r.hash) return false;
    prev = r.hash;
  }
  return true;
}

export function defaultDataDir(): string {
  const env = process.env['VIBEDONATE_DIR'];
  return env && env.length > 0 ? env : join(homedir(), '.vibedonate');
}
export function configPath(dir: string = defaultDataDir()): string { return join(dir, 'config.json'); }
export function meteringPath(dir: string = defaultDataDir()): string { return join(dir, 'metering.json'); }
export function consentPath(dir: string = defaultDataDir()): string { return join(dir, 'consent.json'); }

function ensureDir(dir: string): void { mkdirSync(dir, { recursive: true }); }
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

export function loadConfigFromFile(dir: string = defaultDataDir()): import('./donation-config.js').DonationConfig | null {
  return readJson<import('./donation-config.js').DonationConfig>(configPath(dir));
}
export function saveConfigToFile(config: import('./donation-config.js').DonationConfig, dir: string = defaultDataDir()): void {
  writeJson(configPath(dir), config, dir);
}
export function fileMeteringStore(dir: string = defaultDataDir()): MeteringStore {
  return {
    load() { const data = readJson<UsageReceipt[]>(meteringPath(dir)); return data ?? []; },
    save(receipts) { writeJson(meteringPath(dir), receipts, dir); },
  };
}
export function fileConsentStore(dir: string = defaultDataDir()): import('@pooriaarab/vibe-core').ConsentStore {
  return {
    load() { const data = readJson<{ scope: string; grantedAt: string; note?: string }[]>(consentPath(dir)); return data ?? []; },
    save(grants) { writeJson(consentPath(dir), grants, dir); },
  };
}

export function createMeteringLedger(store?: MeteringStore): MeteringLedger {
  const receipts: UsageReceipt[] = store ? store.load().slice() : [];
  const persist = (): void => { store?.save(receipts); };
  const headHash = (): string => {
    const last = receipts[receipts.length - 1];
    return last !== undefined ? last.hash : GENESIS_HASH;
  };
  return {
    record(input) {
      validateRecordInput(input);
      const seq = receipts.length;
      const ts = input.ts ?? new Date().toISOString();
      const direction = input.direction ?? 'donated';
      const prev = headHash();
      const receipt = buildReceipt({ seq, prev, input, ts, direction });
      receipts.push(receipt);
      persist();
      return receipt;
    },
    all() { return receipts.slice(); },
    totals(now = new Date()) { return computeTotals(receipts, now); },
    remainingToday(cap, now = new Date()) { return Math.max(0, cap - computeTotals(receipts, now).donatedToday); },
    verify() { return verifyChain(receipts); },
  };
}
