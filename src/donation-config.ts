import { parsePriceUsdc } from './payment.js';

export const DONATE_COMPUTE_SCOPE = 'donate:compute' as const;
export type DonationTier = 'compute';
export type RecipientPool =
  | { readonly kind: 'open' }
  | { readonly kind: 'org'; readonly id: string; readonly members: readonly string[] }
  | { readonly kind: 'allowlist'; readonly peers: readonly string[] };
export interface IdleWindow { readonly start: string; readonly end: string; }
export interface DonationConfig {
  readonly tier: DonationTier;
  readonly idle: IdleWindow;
  readonly cap: number;
  readonly pool: RecipientPool;
  readonly enabled: boolean;
  readonly priceUsdc: number;
  readonly chain: import('./payment.js').Chain;
  readonly createdAt: string;
}
export interface CreateDonationConfigOpts {
  readonly tier?: DonationTier;
  readonly idle: string;
  readonly cap: number | string;
  readonly pool: string;
  readonly enabled?: boolean;
  readonly price?: number | string;
  readonly chain?: import('./payment.js').Chain;
}

const CAP_MULT: Readonly<Record<string, number>> = { k: 1_000, m: 1_000_000 };

export function toMinutes(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m || m[1] === undefined || m[2] === undefined) throw new Error(`invalid time (expected HH:MM): ${JSON.stringify(hhmm)}`);
  const h = Number(m[1]); const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`invalid time (out of range): ${JSON.stringify(hhmm)}`);
  return h * 60 + min;
}

function minutesOf(d: Date): number { return d.getUTCHours() * 60 + d.getUTCMinutes(); }

export function withinIdleWindow(window: IdleWindow, now: Date): boolean {
  const start = toMinutes(window.start);
  const end = toMinutes(window.end);
  const cur = minutesOf(now);
  if (start === end) return true;
  if (start < end) return cur >= start && cur < end;
  return cur >= start || cur < end;
}

export function parseIdleWindow(idle: string): IdleWindow {
  const parts = idle.split('-');
  if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) throw new Error(`invalid idle window (expected HH:MM-HH:MM): ${JSON.stringify(idle)}`);
  const start = parts[0].trim(); const end = parts[1].trim();
  toMinutes(start); toMinutes(end);
  return { start, end };
}

export function parseCap(input: number | string): number {
  let n: number;
  if (typeof input === 'number') n = input;
  else {
    const m = /^(\d+(?:\.\d+)?)([km])?$/i.exec(input.trim());
    if (!m || m[1] === undefined) throw new Error(`invalid cap (expected a number or e.g. 2M): ${JSON.stringify(input)}`);
    const base = Number(m[1]);
    const mult = m[2] !== undefined ? (CAP_MULT[m[2].toLowerCase()] ?? 1) : 1;
    n = base * mult;
  }
  const floored = Math.floor(n);
  if (!Number.isFinite(floored) || floored <= 0) throw new Error(`invalid cap (must be a positive number): ${JSON.stringify(input)}`);
  return floored;
}

export function parsePool(pool: string): RecipientPool {
  const trimmed = pool.trim();
  if (trimmed === 'open' || trimmed === 'open:') return { kind: 'open' };
  const idx = trimmed.indexOf(':');
  if (idx === -1) throw new Error(`invalid pool (expected open|org:id|allowlist:peers): ${JSON.stringify(pool)}`);
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

export function createDonationConfig(opts: CreateDonationConfigOpts): DonationConfig {
  if (opts.tier !== undefined && opts.tier !== 'compute') throw new Error(`vibedonate v0 only supports the "compute" tier (got ${JSON.stringify(opts.tier)})`);
  const idle = parseIdleWindow(opts.idle);
  const cap = parseCap(opts.cap);
  const pool = parsePool(opts.pool);
  const priceUsdc = opts.price === undefined ? 0 : opts.price === 0 ? 0 : parsePriceUsdc(opts.price);
  const chain = opts.chain ?? 'base';
  return { tier: 'compute', idle, cap, pool, enabled: opts.enabled ?? true, priceUsdc, chain, createdAt: new Date().toISOString() };
}

export function isSharingActive(config: DonationConfig, now: Date, systemBusy: boolean, donatedToday = 0): boolean {
  if (!config.enabled) return false;
  if (systemBusy) return false;
  if (donatedToday >= config.cap) return false;
  return withinIdleWindow(config.idle, now);
}

export function authorizePeer(config: DonationConfig, peerId: string): 'allow' | 'deny' {
  const { pool } = config;
  switch (pool.kind) {
    case 'open': return 'allow';
    case 'allowlist': return pool.peers.includes(peerId) ? 'allow' : 'deny';
    case 'org': return pool.members.includes(peerId) ? 'allow' : 'deny';
  }
}
