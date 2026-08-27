import { hostname } from 'node:os';
import { createDonationConfig, parsePool, type DonationConfig, type RecipientPool } from './donation-config.js';
import { parsePriceUsdc, type Chain } from './payment.js';
import type { ParsedCommand } from './cli-types.js';

export function parseChain(raw: string): Chain {
  const v = raw.trim().toLowerCase();
  if (v !== 'base' && v !== 'ethereum' && v !== 'polygon') throw new Error(`--chain must be base|ethereum|polygon (got ${JSON.stringify(raw)})`);
  return v;
}

export function takeFlagValue(flag: string, raw: string, advance: () => string | undefined): string {
  const eq = raw.indexOf('=');
  if (eq !== -1) return raw.slice(eq + 1);
  const next = advance();
  if (next === undefined) throw new Error(`${flag} requires a value`);
  return next;
}

type ShareOut = { idle?: string; cap?: string; pool?: string; handle?: string; compute: boolean; price?: string; chain?: string };
type SharePartial = Partial<Omit<ShareOut, 'compute'>>;

const SHARE_FIELDS = {
  idle: (v: string): SharePartial => ({ idle: v }),
  cap: (v: string): SharePartial => ({ cap: v }),
  pool: (v: string): SharePartial => ({ pool: v }),
  handle: (v: string): SharePartial => ({ handle: v }),
  price: (v: string): SharePartial => ({ price: v }),
  chain: (v: string): SharePartial => ({ chain: v }),
} satisfies Record<string, (v: string) => SharePartial>;

function isComputeFlag(a: string): boolean {
  return a === '--compute' || a.startsWith('--compute=');
}

function getFlagName(a: string): string | null {
  if (!a.startsWith('--')) return null;
  const eq = a.indexOf('=');
  const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
  return name.length > 0 ? name : null;
}

function parseShareFields(opts: readonly string[], take: typeof takeFlagValue): ShareOut {
  const out: ShareOut = { compute: false };
  for (let i = 0; i < opts.length; i += 1) {
    const a = opts[i];
    if (a === undefined) continue;
    const advance = (): string | undefined => opts[(i += 1)];
    if (isComputeFlag(a)) {
      out.compute = true;
      continue;
    }
    const flag = getFlagName(a);
    if (flag !== null && Object.hasOwn(SHARE_FIELDS, flag)) {
      const handler = SHARE_FIELDS[flag as keyof typeof SHARE_FIELDS];
      const value = take(`--${flag}`, a, advance);
      Object.assign(out, handler(value));
      continue;
    }
    throw new Error(`unexpected option: ${JSON.stringify(a)}`);
  }
  return out;
}

export function parseShare(opts: readonly string[]): { readonly config: DonationConfig; readonly handle: string } {
  const f = parseShareFields(opts, takeFlagValue);
  if (!f.compute) throw new Error('vibedonate v0 only supports --compute (local-compute tier)');
  if (f.idle === undefined) throw new Error('--idle is required (e.g. --idle 22:00-07:00)');
  if (f.cap === undefined) throw new Error('--cap is required (e.g. --cap 2000000 or --cap 2M)');
  if (f.pool === undefined) throw new Error('--pool is required (open|org:id|allowlist:peers)');
  const resolvedChain = f.chain === undefined ? undefined : parseChain(f.chain);
  return {
    config: createDonationConfig({ idle: f.idle, cap: f.cap, pool: f.pool, ...(f.price === undefined ? {} : { price: f.price }), ...(resolvedChain === undefined ? {} : { chain: resolvedChain }) }),
    handle: (f.handle ?? hostname()).slice(0, 64),
  };
}

type RequestOut = { prompt?: string; pool?: string; handle: string; timeoutMs?: number; pay?: string };

const REQUEST_FIELDS = {
  pool: (v: string): Partial<RequestOut> => ({ pool: v }),
  handle: (v: string): Partial<RequestOut> => ({ handle: v }),
  pay: (v: string): Partial<RequestOut> => ({ pay: v }),
  timeout: (v: string): Partial<RequestOut> => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`--timeout must be a positive number (got ${JSON.stringify(v)})`);
    return { timeoutMs: Math.floor(n) };
  },
} satisfies Record<string, (v: string) => Partial<RequestOut>>;

function parseRequestFields(opts: readonly string[], take: typeof takeFlagValue): RequestOut {
  const out: RequestOut = { handle: 'consumer' };
  for (let i = 0; i < opts.length; i += 1) {
    const a = opts[i];
    if (a === undefined) continue;
    const advance = (): string | undefined => opts[(i += 1)];
    const flag = getFlagName(a);
    if (flag !== null && Object.hasOwn(REQUEST_FIELDS, flag)) {
      const handler = REQUEST_FIELDS[flag as keyof typeof REQUEST_FIELDS];
      const value = take(`--${flag}`, a, advance);
      Object.assign(out, handler(value));
      continue;
    }
    if (a.startsWith('--')) throw new Error(`unexpected option: ${JSON.stringify(a)}`);
    if (out.prompt === undefined) {
      out.prompt = a;
      continue;
    }
    throw new Error(`unexpected argument: ${JSON.stringify(a)} (only one prompt is allowed)`);
  }
  return out;
}

export function parseRequest(opts: readonly string[]): Extract<ParsedCommand, { kind: 'request' }> {
  const f = parseRequestFields(opts, takeFlagValue);
  if (f.prompt === undefined) throw new Error('request needs a prompt: vibedonate request "<prompt>" --pool <p>');
  if (f.pool === undefined) throw new Error("--pool is required (must match a donor's pool definition)");
  const payUsdc = f.pay === undefined ? undefined : parsePriceUsdc(f.pay);
  return { kind: 'request', prompt: f.prompt, pool: parsePool(f.pool), handle: f.handle.slice(0, 64), ...(f.timeoutMs === undefined ? {} : { timeoutMs: f.timeoutMs }), ...(payUsdc === undefined ? {} : { payUsdc }) };
}

const COMMAND_HANDLERS = {
  share: (args: readonly string[]): ParsedCommand => {
    const parsed = parseShare(args);
    return { kind: 'share', config: parsed.config, handle: parsed.handle };
  },
  request: (args: readonly string[]): ParsedCommand => parseRequest(args),
  status: (_args: readonly string[]): ParsedCommand => ({ kind: 'status' }),
  stop: (_args: readonly string[]): ParsedCommand => ({ kind: 'stop' }),
  mcp: (_args: readonly string[]): ParsedCommand => ({ kind: 'mcp' }),
  wallet: (_args: readonly string[]): ParsedCommand => ({ kind: 'wallet' }),
} satisfies Record<string, (args: readonly string[]) => ParsedCommand>;

export function parseArgs(argv: readonly string[]): ParsedCommand {
  const args = [...argv];
  if (args.length === 0) return { kind: 'help' };
  if (args.includes('--help') || args.includes('-h')) return { kind: 'help' };
  if (args.includes('--version') || args.includes('-v')) return { kind: 'version' };
  const cmd = args[0];
  if (cmd === undefined) throw new Error('unknown command: missing');
  if (Object.hasOwn(COMMAND_HANDLERS, cmd)) {
    const handler = COMMAND_HANDLERS[cmd as keyof typeof COMMAND_HANDLERS];
    return handler(args.slice(1));
  }
  throw new Error(`unknown command: ${JSON.stringify(cmd)}. See 'vibedonate --help'.`);
}
export type { ParsedCommand } from './cli-types.js';
