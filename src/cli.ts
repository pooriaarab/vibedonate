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

import { createConsentLedger } from '@pooriaarab/vibe-core';

import {
  createDonationConfig,
  createMeteringLedger,
  defaultDataDir,
  DONATE_COMPUTE_SCOPE,
  fileConsentStore,
  fileMeteringStore,
  isSharingActive,
  loadConfigFromFile,
  publishDonationEvent,
  resolveCompute,
  saveConfigToFile,
  type ComputeResolution,
  type DonationConfig,
} from './index.js';

/** Matches package.json — single source for the `--version` string. */
const VERSION = '0.2.0';

export type ParsedCommand =
  | { readonly kind: 'help' }
  | { readonly kind: 'version' }
  | { readonly kind: 'share'; readonly config: DonationConfig }
  | { readonly kind: 'status' }
  | {readonly kind: 'stop' }
  | { readonly kind: 'mcp' };

const HELP = `vibedonate ${VERSION} — donate spare local compute across agentic CLIs.

USAGE
  vibedonate share --compute --idle <HH:MM-HH:MM> --cap <n|2M> --pool <pool>
  vibedonate status
  vibedonate stop
  vibedonate mcp
  vibedonate --version | --help

COMMANDS
  share    Arm donation: set what/when/who and write config + grant consent.
           --compute           donate local compute (the only v0 tier)
           --idle HH:MM-HH:MM  idle window; may wrap midnight (e.g. 22:00-07:00)
           --cap N|2M|500k     max tokens donated per UTC day
           --pool open|org:id[,member...]|allowlist:peer,peer

  status   Show config, metering totals, the resolved local model, and whether
           sharing right now.
  stop     Disable donation (revokes the donate:compute consent grant).
  mcp      Run the MCP server over stdio (tools: status, request_capacity).

LOCAL COMPUTE
  'status' and the MCP 'status'/'request_capacity' tools probe for an on-device
  model via vibe-core's cascade (Ollama by default; set VIBEDONATE_OLLAMA_MODEL).
  Donated compute is served on-device only — it never leaves your machine.

DATA
  State lives in $VIBEDONATE_DIR (default ~/.vibedonate): config.json,
  consent.json, metering.json. Nothing leaves your machine.

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
    case 'share':
      return { kind: 'share', config: parseShare(args.slice(1)) };
    case 'status':
      return { kind: 'status' };
    case 'stop':
      return { kind: 'stop' };
    case 'mcp':
      return { kind: 'mcp' };
    default:
      throw new Error(`unknown command: ${JSON.stringify(cmd)}. See 'vibedonate --help'.`);
  }
}

/** Parse `share` options into a validated {@link DonationConfig}. Throws on error. */
function parseShare(opts: readonly string[]): DonationConfig {
  let idle: string | undefined;
  let cap: string | undefined;
  let pool: string | undefined;
  let compute = false;

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
    throw new Error(`unexpected option: ${JSON.stringify(a)}`);
  }

  if (!compute) throw new Error('vibedonate v0 only supports --compute (local-compute tier)');
  if (idle === undefined) throw new Error('--idle is required (e.g. --idle 22:00-07:00)');
  if (cap === undefined) throw new Error('--cap is required (e.g. --cap 2000000 or --cap 2M)');
  if (pool === undefined) throw new Error('--pool is required (open|org:id|allowlist:peers)');

  return createDonationConfig({ idle, cap, pool });
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
      createMeteringLedger(fileMeteringStore(dir));
      publishDonationEvent('share', { tier: cmd.config.tier });
      process.stdout.write(renderStatus(cmd.config, 0, { donated: 0, received: 0, count: 0 }, true, new Date()));
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
    case 'mcp': {
      const { runMcpServer } = await import('./mcp.js');
      await runMcpServer(dir);
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
