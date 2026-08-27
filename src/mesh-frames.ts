import type { Chain, PaymentProof } from './payment.js';

export const MAX_HANDLE_LEN = 64;
export const MAX_POOL_LEN = 96;
export const MAX_TIER_LEN = 32;
export const MAX_ID_LEN = 64;
export const MAX_PROMPT_LEN = 8_000;
export const MAX_OUTPUT_LEN = 16_000;
export const MAX_REASON_LEN = 256;
export const MAX_ADDR_LEN = 64;
export const MAX_TXREF_LEN = 128;
export const MAX_SIG_LEN = 256;
export const MAX_FRAME_LEN = Math.max(MAX_PROMPT_LEN, MAX_OUTPUT_LEN) * 2 + 2_048;

export type Frame =
  | { readonly t: 'hello'; readonly handle: string; readonly pool: string; readonly capacityTier: string; readonly priceUsdc?: number; readonly payTo?: string; readonly chain?: Chain; }
  | { readonly t: 'job'; readonly id: string; readonly prompt: string; readonly payment?: PaymentProof; }
  | { readonly t: 'result'; readonly id: string; readonly output: string; readonly denied?: true; readonly reason?: string; };

export type PeerHello = Extract<Frame, { t: 'hello' }>;

type FieldSpec<T> = { readonly field: string; readonly parse: (v: unknown) => T | null; readonly required: boolean; };

function strInRange(max: number, allowEmpty: boolean): (v: unknown) => string | null {
  return (v) => typeof v === 'string' && (allowEmpty || v.length > 0) && v.length <= max ? v : null;
}

function parseTier(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_TIER_LEN ? v : null;
}

function parsePrice(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

function parseChain(v: unknown): Chain | null {
  return v === 'base' || v === 'ethereum' || v === 'polygon' ? v as Chain : null;
}

function isRecordValue(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isValidAmount(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

function applyPaymentSpecs(r: Record<string, unknown>, out: Record<string, unknown>): boolean {
  const specs: FieldSpec<unknown>[] = [
    { field: 'payer', parse: strInRange(MAX_HANDLE_LEN, false), required: true },
    { field: 'amountUsdc', parse: isValidAmount, required: true },
    { field: 'txRef', parse: strInRange(MAX_TXREF_LEN, false), required: true },
    { field: 'sig', parse: strInRange(MAX_SIG_LEN, false), required: false },
  ];
  for (const s of specs) {
    const val = r[s.field];
    if (val === undefined) {
      if (s.required) return false;
      continue;
    }
    const parsed = s.parse(val);
    if (parsed === null) return false;
    out[s.field] = parsed;
  }
  return true;
}

function parsePaymentProofField(raw: unknown): PaymentProof | null {
  if (!isRecordValue(raw)) return null;
  const r = raw;
  const out: Record<string, unknown> = {};
  if (!applyPaymentSpecs(r, out)) return null;
  const payer = out['payer'];
  const amountUsdc = out['amountUsdc'];
  const txRef = out['txRef'];
  if (typeof payer !== 'string' || typeof amountUsdc !== 'number' || typeof txRef !== 'string') return null;
  const sig = out['sig'];
  return { payer, amountUsdc, txRef, ...(typeof sig === 'string' ? { sig } : {}) };
}

function helloPriceFields(opts: { r: Record<string, unknown>; price: number; handle: string; pool: string; capacityTier: string }): Frame {
  const { r, price, handle, pool, capacityTier } = opts;
  const payToRaw = r['payTo'];
  const chainRaw = r['chain'];
  const payTo = typeof payToRaw === 'string' && payToRaw.length > 0 && payToRaw.length <= MAX_ADDR_LEN ? payToRaw : undefined;
  const chain = parseChain(chainRaw) ?? undefined;
  return { t: 'hello', handle, pool, capacityTier, priceUsdc: price, ...(payTo !== undefined ? { payTo } : {}), ...(chain !== undefined ? { chain } : {}) };
}

function parseHello(r: Record<string, unknown>): Frame | null {
  const handle = strInRange(MAX_HANDLE_LEN, false)(r['handle']);
  const pool = strInRange(MAX_POOL_LEN, false)(r['pool']);
  if (handle === null || pool === null) return null;
  const capacityTier = parseTier(r['capacityTier']) ?? 'compute';
  const price = parsePrice(r['priceUsdc']);
  if (price !== null) return helloPriceFields({ r, price, handle, pool, capacityTier });
  return { t: 'hello', handle, pool, capacityTier };
}

function parseJob(r: Record<string, unknown>): Frame | null {
  const id = strInRange(MAX_ID_LEN, false)(r['id']);
  const prompt = typeof r['prompt'] === 'string' && r['prompt'].length <= MAX_PROMPT_LEN ? r['prompt'] : null;
  if (id === null || prompt === null) return null;
  const payment = parsePaymentProofField(r['payment']);
  return payment === null ? { t: 'job', id, prompt } : { t: 'job', id, prompt, payment };
}

function isValidDenied(v: unknown): boolean {
  return v === undefined || v === true;
}

function isValidReason(v: unknown): boolean {
  return v === undefined || (typeof v === 'string' && v.length <= MAX_REASON_LEN);
}

function parseResult(r: Record<string, unknown>): Frame | null {
  const id = strInRange(MAX_ID_LEN, false)(r['id']);
  const output = typeof r['output'] === 'string' && r['output'].length <= MAX_OUTPUT_LEN ? r['output'] : null;
  if (id === null || output === null) return null;
  if (!isValidDenied(r['denied'])) return null;
  if (!isValidReason(r['reason'])) return null;
  const denied = r['denied'];
  const reason = r['reason'];
  return { t: 'result', id, output, ...(denied === true ? { denied: true } : {}), ...(typeof reason === 'string' ? { reason } : {}) };
}

const parsers: Record<string, (r: Record<string, unknown>) => Frame | null> = {
  hello: parseHello,
  job: parseJob,
  result: parseResult,
};

export function parseFrame(raw: string | Buffer): Frame | null {
  const text = typeof raw === 'string' ? raw : raw.toString('utf8');
  if (text.length > MAX_FRAME_LEN) return null;
  let d: unknown;
  try { d = JSON.parse(text); } catch { return null; }
  if (!isRecordValue(d)) return null;
  const r = d as Record<string, unknown>;
  const t = r['t'];
  if (typeof t !== 'string') return null;
  const fn = parsers[t];
  return fn ? fn(r) : null;
}

function serializeHello(f: Extract<Frame, { t: 'hello' }>): string {
  const base: Record<string, unknown> = { t: 'hello', handle: f.handle, pool: f.pool, capacityTier: f.capacityTier };
  if (typeof f.priceUsdc === 'number' && f.priceUsdc > 0) {
    base['priceUsdc'] = f.priceUsdc;
    if (typeof f.payTo === 'string' && f.payTo.length > 0) base['payTo'] = f.payTo;
    if (typeof f.chain === 'string') base['chain'] = f.chain;
  }
  return JSON.stringify(base);
}

function serializeJob(f: Extract<Frame, { t: 'job' }>): string {
  const base: Record<string, unknown> = { t: 'job', id: f.id, prompt: f.prompt };
  if (f.payment !== undefined) {
    const p: Record<string, unknown> = { payer: f.payment.payer, amountUsdc: f.payment.amountUsdc, txRef: f.payment.txRef };
    if (typeof f.payment.sig === 'string') p['sig'] = f.payment.sig;
    base['payment'] = p;
  }
  return JSON.stringify(base);
}

function serializeResult(f: Extract<Frame, { t: 'result' }>): string {
  const base: Record<string, unknown> = { t: 'result', id: f.id, output: f.output };
  if (f.denied === true) base['denied'] = true;
  if (typeof f.reason === 'string' && f.reason.length > 0) base['reason'] = f.reason;
  return JSON.stringify(base);
}

export function serializeFrame(f: Frame): string {
  switch (f.t) {
    case 'hello': return serializeHello(f);
    case 'job': return serializeJob(f);
    case 'result': return serializeResult(f);
  }
}
