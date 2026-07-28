#!/usr/bin/env node
/**
 * vibedonate CLI.
 *
 *   vibedonate share --compute --idle 22:00-07:00 --cap 2M --pool allowlist:alice,bob
 *   vibedonate status
 *   vibedonate stop
 *   vibedonate mcp
 *
 * The argument parser is pure (`parseArgs`) so it is unit-tested directly; the
 * `runCli` glue is thin — it persists config + consent + metering under
 * `$VIBEDONATE_DIR` (default `~/.vibedonate`) and prints status. No third-party
 * arg-parsing dependency: a tiny hand-rolled loop is all v0 needs.
 */

import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { hostname } from 'node:os';

import { createConsentLedger } from '@pooriaarab/vibe-core';

import {
  createDonationConfig,
  createMeteringLedger,
  createPaymentLedger,
  defaultDataDir,
  DONATE_COMPUTE_SCOPE,
  fileConsentStore,
  fileMeteringStore,
  filePaymentStore,
  isSharingActive,
  loadConfigFromFile,
  parsePool,
  parsePriceUsdc,
  publishDonationEvent,
  resolveCompute,
  saveConfigToFile,
  stubWallet,
  type Chain,
  type ComputeResolution,
  type DonationConfig,
  type PaymentRecord,
  type PaymentTotals,
  type RecipientPool,
} from './index.js';

/** Matches package.json — single source for the `--version` string. */
const VERSION = '0.3.0';

export type ParsedCommand =
  | { readonly kind: 'help' }
  | { readonly kind: 'version' }
  | { readonly kind: 'share'; readonly config: DonationConfig; readonly handle: string }
  | { readonly kind: 'status' }
  | { readonly kind: 'stop' }
  | { readonly kind: 'mcp' }
  | {
      readonly kind: 'request';
      readonly prompt: string;
      readonly pool: RecipientPool;
      readonly handle: string;
      readonly timeoutMs?: number;
      /** Per-job USDC the consumer is willing to pay; omitted = auto-read donor price. */
      readonly payUsdc?: number;
    }
  | { readonly kind: 'wallet' };

const HELP = `vibedonate ${VERSION} — donate spare local compute across agentic CLIs.

USAGE
  vibedonate share --compute --idle <HH:MM-HH:MM> --cap <n|2M> --pool <pool> [--price <usdc>]
  vibedonate request "<prompt>" --pool <pool> [--handle <peer>] [--timeout <ms>] [--pay <usdc>]
  vibedonate status
  vibedonate stop
  vibedonate wallet
  vibedonate mcp
  vibedonate --version | --help

COMMANDS
  share    Arm donation AND join the live mesh as a donor (consent-gated).
           Stays online serving jobs from a local stub model until Ctrl-C.
           --compute           donate local compute (the only v0 tier)
           --idle HH:MM-HH:MM  idle window; may wrap midnight (e.g. 22:00-07:00)
           --cap N|2M|500k     max tokens donated per UTC day
           --pool open|org:id[,member...]|allowlist:peer,peer
           --handle <name>     your donor id on the mesh (default: hostname)
           --price <usdc>      x402: charge per job in USDC (default 0 = FREE).
                                When set, jobs are refused without a valid
                                PaymentProof. FREE stays the default.
           --chain base|ethereum|polygon  settlement chain (default base)

  request  Route ONE job to an authorized, capacity-green donor on the pool.
           Prints the result on stdout (exit 0) or a denial on stderr (exit 1).
           --pool <pool>       must match a donor's pool definition (same topic)
           --handle <peer>     your id - must be in an allowlist/org pool roster
           --timeout <ms>      discovery + run budget (default 15000)
           --pay <usdc>        x402: offer per job (default: auto-read the
                                donor's advertised price). A priced donor denies
                                with 'payment required' if payment is missing.

  status   Show config, metering totals, the resolved local model, and whether
           sharing right now.
  stop     Disable donation (revokes the donate:compute consent grant).
  wallet   Show your x402 wallet address + a hash-chained ledger of payments
           received (as a donor) and sent (as a consumer).
  mcp      Run the MCP server over stdio (tools: status, request_capacity).

LOCAL COMPUTE
  'status' and the MCP 'status'/'request_capacity' tools probe for an on-device
  model via vibe-core's cascade (Ollama by default; set VIBEDONATE_OLLAMA_MODEL).
  Donated compute is served on-device only — it never leaves your machine.

MESH
  Donors + consumers discover each other over the hyperswarm DHT on a topic
  derived from the pool. Handshakes carry ONLY { handle, pool, tier } (and, for
  a priced donor, the price + receiving address) - raw usage is NEVER shared.
  The donor gates every job on consent + pool auth + PAYMENT (if priced) +
  capacity BEFORE any work runs, then records a hash-chained metering receipt
  (and, for priced jobs, a payment record).

PAYMENTS (x402)
  FREE is the default: price 0 donors never build PaymentTerms and free jobs
  are byte-for-byte unchanged. A donor that sets --price charges USDC per job
  via the open HTTP 402 standard. v0 does NOT do real on-chain settlement - a
  deterministic stub wallet (always 'paid') exercises the gate end-to-end; a
  real USDC wallet implements the Wallet interface and drops in unchanged.

DATA
  State lives in $VIBEDONATE_DIR (default ~/.vibedonate): config.json,
  consent.json, metering.json, payments.json.

NOTE
  v0 is the local-compute tier only. Routing a peer's inference through your
  account or API key needs trust/legal design first (see docs/spec.md).
`;

/** Parse `vibedonate` args. Pure: no IO, no process mutation. Throws on bad input. */
export function parseArgs(argv: readonly string[]): ParsedCommand {
  const args = [...argv];
  if (args.length === 0) return { kind: 'help' };
  if (args.includes('--help') || args.includes('-h')) return { kind: 'help' };
  if (args.includes('--version') || args.includes('-v')) return { kind: 'version' };

  const cmd = args[0];
  switch (cmd) {
    case 'share': {
      const parsed = parseShare(args.slice(1));
      return { kind: 'share', config: parsed.config, handle: parsed.handle };
    }
    case 'request':
      return parseRequest(args.slice(1));
    case 'status':
      return { kind: 'status' };
    case 'stop':
      return { kind: 'stop' };
    case 'mcp':
      return { kind: 'mcp' };
    case 'wallet':
      return { kind: 'wallet' };
    default:
      throw new Error(`unknown command: ${JSON.stringify(cmd)}. See 'vibedonate --help'.`);
  }
}

/** Parse `share` options into a validated config + donor handle. Throws on error. */
function parseShare(opts: readonly string[]): {
  readonly config: DonationConfig;
  readonly handle: string;
} {
  let idle: string | undefined;
  let cap: string | undefined;
  let pool: string | undefined;
  let handle: string | undefined;
  let compute = false;
  let price: string | undefined;
  let chain: string | undefined;

  const takeValue = (flag: string, raw: string, advance: () => string | undefined): string => {
    const eq = raw.indexOf('=');
    if (eq !== -1) return raw.slice(eq + 1);
    const next = advance();
    if (next === undefined) throw new Error(`${flag} requires a value`);
    return next;
  };

  for (let i = 0; i < opts.length; i += 1) {
    const a = opts[i];
    if (a === undefined) continue;
    const advance = () => opts[(i += 1)];
    if (a === '--compute' || a.startsWith('--compute=')) {
      compute = true;
      continue;
    }
    if (a === '--idle' || a.startsWith('--idle=')) {
      idle = takeValue('--idle', a, advance);
      continue;
    }
    if (a === '--cap' || a.startsWith('--cap=')) {
      cap = takeValue('--cap', a, advance);
      continue;
    }
    if (a === '--pool' || a.startsWith('--pool=')) {
      pool = takeValue('--pool', a, advance);
      continue;
    }
    if (a === '--handle' || a.startsWith('--handle=')) {
      handle = takeValue('--handle', a, advance);
      continue;
    }
    if (a === '--price' || a.startsWith('--price=')) {
      // x402 per-job USDC price (e.g. --price 0.001). Default 0 = FREE.
      price = takeValue('--price', a, advance);
      continue;
    }
    if (a === '--chain' || a.startsWith('--chain=')) {
      chain = takeValue('--chain', a, advance);
      continue;
    }
    throw new Error(`unexpected option: ${JSON.stringify(a)}`);
  }

  if (!compute) throw new Error('vibedonate v0 only supports --compute (local-compute tier)');
  if (idle === undefined) throw new Error('--idle is required (e.g. --idle 22:00-07:00)');
  if (cap === undefined) throw new Error('--cap is required (e.g. --cap 2000000 or --cap 2M)');
  if (pool === undefined) throw new Error('--pool is required (open|org:id|allowlist:peers)');

  const resolvedChain = chain === undefined ? undefined : parseChain(chain);
  return {
    config: createDonationConfig({
      idle,
      cap,
      pool,
      ...(price === undefined ? {} : { price }),
      ...(resolvedChain === undefined ? {} : { chain: resolvedChain }),
    }),
    // Cap at the mesh handshake MAX_HANDLE_LEN so an over-long hostname can't
    // make our own hello fail validation on the wire.
    handle: (handle ?? hostname()).slice(0, 64),
  };
}

/** Validate a --chain value into the x402 Chain union. Throws on unknown chain. */
function parseChain(raw: string): Chain {
  const v = raw.trim().toLowerCase();
  if (v !== 'base' && v !== 'ethereum' && v !== 'polygon') {
    throw new Error(`--chain must be base|ethereum|polygon (got ${JSON.stringify(raw)})`);
  }
  return v;
}

/** Parse `request` options into a consumer command. Pure: no IO. Throws on error. */
function parseRequest(opts: readonly string[]): Extract<ParsedCommand, { kind: 'request' }> {
  let prompt: string | undefined;
  let pool: string | undefined;
  let handle = 'consumer';
  let timeoutMs: number | undefined;
  let pay: string | undefined;

  const takeValue = (flag: string, raw: string, advance: () => string | undefined): string => {
    const eq = raw.indexOf('=');
    if (eq !== -1) return raw.slice(eq + 1);
    const next = advance();
    if (next === undefined) throw new Error(`${flag} requires a value`);
    return next;
  };

  for (let i = 0; i < opts.length; i += 1) {
    const a = opts[i];
    if (a === undefined) continue;
    const advance = () => opts[(i += 1)];
    if (a === '--pool' || a.startsWith('--pool=')) {
      pool = takeValue('--pool', a, advance);
      continue;
    }
    if (a === '--handle' || a.startsWith('--handle=')) {
      handle = takeValue('--handle', a, advance);
      continue;
    }
    if (a === '--timeout' || a.startsWith('--timeout=')) {
      const raw = takeValue('--timeout', a, advance);
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`--timeout must be a positive number (got ${JSON.stringify(raw)})`);
      }
      timeoutMs = Math.floor(n);
      continue;
    }
    if (a === '--pay' || a.startsWith('--pay=')) {
      // x402: per-job USDC to offer a priced donor. Omitted = auto-read the
      // donor's advertised price. A FREE donor ignores payment entirely.
      pay = takeValue('--pay', a, advance);
      continue;
    }
    if (a.startsWith('--')) throw new Error(`unexpected option: ${JSON.stringify(a)}`);
    // First non-flag token is the prompt (shell-passed, may be quoted).
    if (prompt === undefined) {
      prompt = a;
    } else {
      throw new Error(`unexpected argument: ${JSON.stringify(a)} (only one prompt is allowed)`);
    }
  }

  if (prompt === undefined) {
    throw new Error('request needs a prompt: vibedonate request "<prompt>" --pool <p>');
  }
  if (pool === undefined) {
    throw new Error("--pool is required (must match a donor's pool definition)");
  }
  const payUsdc = pay === undefined ? undefined : parsePriceUsdc(pay);
  return {
    kind: 'request',
    prompt,
    pool: parsePool(pool),
    handle: handle.slice(0, 64),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(payUsdc === undefined ? {} : { payUsdc }),
  };
}

const BADGE = '\u25CF your machine \u00B7 opt-in';

function poolDesc(pool: DonationConfig['pool']): string {
  switch (pool.kind) {
    case 'open':
      return 'open pool';
    case 'org':
      return `org:${pool.id} (${pool.members.length} member${pool.members.length === 1 ? '' : 's'})`;
    case 'allowlist':
      return `allowlist [${pool.peers.join(', ')}]`;
  }
}

/** Render a human status block from config + metering + live gate. Pure string building. */
export function renderStatus(
  config: DonationConfig | null,
  donatedToday: number,
  totals: { donated: number; received: number; count: number },
  sharing: boolean,
  now: Date,
  localModel?: ComputeResolution | null,
): string {
  if (config === null) {
    return 'vibedonate is not armed. Run `vibedonate share ...` to start.\n';
  }
  const lines: string[] = [];
  lines.push(`vibedonate — ${config.enabled ? 'enabled' : 'stopped'} \u00B7 ${BADGE}`);
  lines.push(`  tier:     ${config.tier}`);
  lines.push(`  idle:     ${config.idle.start}-${config.idle.end} (UTC)`);
  lines.push(`  cap:      ${config.cap.toLocaleString('en-US')} tokens/day`);
  lines.push(`  pool:     ${poolDesc(config.pool)}`);
  if (localModel) {
    lines.push(`  compute:  ${localModel.label}${localModel.available ? '' : ' \u26A0 not usable'}`);
  }
  lines.push(`  usage:    donated ${totals.donated.toLocaleString('en-US')} (today ${donatedToday.toLocaleString('en-US')}) \u00B7 received ${totals.received.toLocaleString('en-US')} \u00B7 ${totals.count} receipt(s)`);
  lines.push(`  sharing:  ${sharing ? 'yes' : 'no'} (now ${now.toISOString()})`);
  return `${lines.join('\n')}\n`;
}

/**
 * Render the x402 wallet view: the node's receiving address + a ledger of
 * payments made (sent) and received, with hash-chain-verified totals. Pure
 * string building — no IO.
 */
export function renderWallet(
  address: string,
  totals: PaymentTotals,
  records: readonly PaymentRecord[],
  chain?: string,
): string {
  const lines: string[] = [];
  lines.push(`vibedonate wallet — ${address}${chain !== undefined ? ` (${chain})` : ''}`);
  lines.push(
    `  payments: received ${totals.received} USDC \u00B7 sent ${totals.sent} USDC \u00B7 ${totals.count} record(s)`,
  );
  if (records.length === 0) {
    lines.push('  (no payments yet \u2014 priced jobs record here once served/paid)');
  } else {
    for (const r of records) {
      const arrow = r.direction === 'received' ? '\u2190' : '\u2192';
      lines.push(
        `  #${r.seq} ${r.ts}  ${arrow} ${r.peer}  ${r.amountUsdc} USDC  ${r.txRef}`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

export interface RunCliOptions {
  readonly dir?: string;
  readonly argv?: readonly string[];
}

/** Run the CLI. Returns the process exit code. Persists state under `dir`. */
export async function runCli(options: RunCliOptions = {}): Promise<number> {
  const dir = options.dir ?? defaultDataDir();
  const argv = options.argv ?? process.argv.slice(2);

  let cmd: ParsedCommand;
  try {
    cmd = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`vibedonate: ${(err as Error).message}\n`);
    return 2;
  }

  switch (cmd.kind) {
    case 'help':
      process.stdout.write(HELP);
      return 0;
    case 'version':
      process.stdout.write(`vibedonate ${VERSION}\n`);
      return 0;
    case 'share': {
      saveConfigToFile(cmd.config, dir);
      // Arm: grant the donate:compute consent scope (the durable opt-in).
      createConsentLedger(fileConsentStore(dir)).grant(DONATE_COMPUTE_SCOPE, 'vibedonate share');
      // Touch the metering file so `status` has stable totals even before first use.
      const ledger = createMeteringLedger(fileMeteringStore(dir));
      publishDonationEvent('share', { tier: cmd.config.tier });
      process.stdout.write(renderStatus(cmd.config, 0, { donated: 0, received: 0, count: 0 }, true, new Date()));
      // Now actually JOIN the mesh as a donor. startDonor re-checks the
      // donate:compute grant (fast-fail) — the caller gate, like vibedating's
      // share:live. Blocks until SIGINT/SIGTERM: a donor stays online to serve.
      const { startDonor, SHARE_NOTICE, poolTopicKey } = await import('./mesh.js');
      process.stdout.write(`${SHARE_NOTICE}\n`);
      const session = await startDonor({
        handle: cmd.handle,
        config: cmd.config,
        consent: createConsentLedger(fileConsentStore(dir)),
        ledger,
        // x402: arm a wallet (the donor's receiving address) + a payment ledger.
        // A priced donor (priceUsdc > 0) needs the wallet to advertise payTo and
        // verify payments; a FREE donor ignores both. Seeded by the donor handle
        // so the advertised payTo is stable and matches `vibedonate wallet`.
        wallet: stubWallet(cmd.handle),
        paymentLedger: createPaymentLedger(filePaymentStore(dir)),
      });
      process.stdout.write(
        `joined mesh as donor "${cmd.handle}" on pool "${poolTopicKey(cmd.config.pool)}" — Ctrl-C to stop.\n`,
      );
      await new Promise<void>((resolve) => {
        const handler = (): void => resolve();
        process.once('SIGINT', handler);
        process.once('SIGTERM', handler);
      });
      await session.close();
      process.stdout.write('vibedonate donor stopped — left the mesh.\n');
      return 0;
    }
    case 'status': {
      const config = loadConfigFromFile(dir);
      const ledger = createMeteringLedger(fileMeteringStore(dir));
      const consent = createConsentLedger(fileConsentStore(dir));
      const now = new Date();
      const totals = ledger.totals(now);
      // Real probe: is there an on-device model that could actually serve?
      const localModel = await resolveCompute();
      const sharing =
        config !== null &&
        consent.allows(DONATE_COMPUTE_SCOPE) &&
        isSharingActive(config, now, false, totals.donatedToday);
      process.stdout.write(renderStatus(config, totals.donatedToday, totals, sharing, now, localModel));
      return 0;
    }
    case 'stop': {
      const config = loadConfigFromFile(dir);
      createConsentLedger(fileConsentStore(dir)).revoke(DONATE_COMPUTE_SCOPE);
      if (config !== null) {
        saveConfigToFile({ ...config, enabled: false }, dir);
      }
      publishDonationEvent('stop');
      process.stdout.write('vibedonate stopped — donation disabled and consent revoked.\n');
      return 0;
    }
    case 'request': {
      // Consumer: route ONE job to an authorized, capacity-green donor on the
      // pool. The consumer holds no consent grant — it is requesting capacity;
      // the DONOR gates every job. A wallet is always armed so we CAN pay a
      // priced donor (auto-reads its advertised price, or --pay overrides);
      // sent payments are recorded to the payment ledger.
      const { startConsumer } = await import('./mesh.js');
      const session = await startConsumer({
        handle: cmd.handle,
        pool: cmd.pool,
        wallet: stubWallet(cmd.handle),
        paymentLedger: createPaymentLedger(filePaymentStore(dir)),
      });
      try {
        const result = await session.request(cmd.prompt, {
          ...(cmd.timeoutMs === undefined ? {} : { timeoutMs: cmd.timeoutMs }),
          ...(cmd.payUsdc === undefined ? {} : { payUsdc: cmd.payUsdc }),
        });
        if (result === null) {
          process.stderr.write('vibedonate: no donor available on the pool\n');
          return 1;
        }
        if (result.denied === true) {
          process.stderr.write(
            `vibedonate: request denied by donor "${result.donor}" — ${result.reason ?? 'unknown'}\n`,
          );
          return 1;
        }
        process.stdout.write(`${result.output}\n`);
        return 0;
      } finally {
        await session.close();
      }
    }
    case 'mcp': {
      const { runMcpServer } = await import('./mcp.js');
      await runMcpServer(dir);
      return 0;
    }
    case 'wallet': {
      // x402: show the node's wallet address + the hash-chained payment ledger
      // (both payments RECEIVED when this node donated compute, and SENT when it
      // consumed a priced donor). The address is seeded by hostname so it matches
      // the default donor's advertised payTo (`vibedonate share` with no --handle).
      const config = loadConfigFromFile(dir);
      const wallet = stubWallet(hostname());
      const ledger = createPaymentLedger(filePaymentStore(dir));
      process.stdout.write(
        renderWallet(wallet.address(), ledger.totals(), ledger.all(), config?.chain),
      );
      return 0;
    }
    default: {
      // Exhaustiveness guard — every ParsedCommand kind is handled above.
      const _exhaustive: never = cmd;
      void _exhaustive;
      return 1;
    }
  }
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  runCli()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`vibedonate: ${(err as Error).message}\n`);
      process.exit(1);
    });
}
